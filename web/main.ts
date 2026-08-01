// claudebrain viewer — dark synapse activity graph for Claude Code sessions.
// Receives normalized hook events over WebSocket, builds a per-session graph
// (session → skills / tools hub / directory tree / agents) and renders pulses
// travelling the path of every action.

import {
  forceSimulation,
  forceManyBody,
  forceLink,
  forceCollide,
  type Simulation,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from 'd3-force';

// ---------------------------------------------------------------- types

interface BrainEvent {
  t: number;
  sid: string;
  event: string;
  cwd: string;
  data: {
    tool?: string;
    input?: Record<string, unknown>;
    isError?: boolean;
    prompt?: string;
    message?: string;
    source?: string;
  };
}

type NodeKind = 'session' | 'hub' | 'tool' | 'skill' | 'dir' | 'file' | 'res' | 'agent';

interface NodeEvent {
  t: string; // formatted time
  full: string; // complete command/action text, used for display, hover and copy
}

interface GNode extends SimulationNodeDatum {
  id: string;
  kind: NodeKind;
  label: string;
  sid: string;
  parentId?: string;
  depth: number; // for dir nodes: 1 = directly under session
  heat: number;
  count: number;
  lastTs: number;
  active?: boolean; // skills: active until turn end; agents: running
  children: number; // dir: direct children; used for semantic zoom
  descCount: number; // dir: total resource events beneath
  events: NodeEvent[];
  flashT0?: number;
  flashColor?: string;
}

interface GEdge extends SimulationLinkDatum<GNode> {
  id: string;
  kind: string;
}

type SessionState = 'active' | 'waiting' | 'attention' | 'ended';

interface SessionInfo {
  sid: string;
  label: string;
  cwd: string;
  center: { x: number; y: number };
  state: SessionState;
  lastTs: number;
  activeSkills: string[];
  runningAgents: string[];
  agentCounter: number;
  resourceCount: number;
  ripples: number[]; // performance.now() start times
}

interface Pulse {
  path: string[];
  t0: number; // performance.now()
  dur: number;
  label: string;
  status: 'pending' | 'ok' | 'err';
  resolvedT0?: number;
}

interface Pending {
  pulse: Pulse | null;
  targetId: string;
  t: number;
  row: HTMLLIElement | null;
}

// ---------------------------------------------------------------- constants

const COLORS = {
  bg: '#07090e',
  edge: '#1b2433',
  session: '#7dd3fc',
  hub: '#2c3a52',
  tool: '#38bdf8',
  skill: '#c084fc',
  dir: '#3d4c6b',
  file: '#94a3b8',
  res: '#a5b4fc',
  agent: '#fbbf24',
  pulse: '#bfe9ff',
  error: '#f87171',
  waiting: '#fbbf24',
  attention: '#fb7185',
};

const SESSION_SPACING_X = 850;
const SESSION_SPACING_Y = 750;
const MAX_PULSES = 60;
const MAX_NODE_EVENTS = 50;
const MAX_RESOURCES_PER_SESSION = 1500;
const REPLAY_FEED_ROWS = 120;

// ---------------------------------------------------------------- state

const nodes: GNode[] = [];
const nodeById = new Map<string, GNode>();
const edges: GEdge[] = [];
const edgeIds = new Set<string>();
const sessions = new Map<string, SessionInfo>();
const pulses: Pulse[] = [];
const pending = new Map<string, Pending[]>(); // key: sid + '\0' + tool
const edgeHeat = new Map<string, number>(); // edgeId -> performance.now()
const highlight = { ids: new Set<string>(), until: 0 };

let eventCount = 0;
let simDirty = false;
let hoverNode: GNode | null = null;
let selectedNode: GNode | null = null;

// camera
const cam = { x: 0, y: 0, k: 0.9 };
let autoCamera = true;

// ---------------------------------------------------------------- DOM

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const connDot = document.getElementById('conn')!;
const statsEl = document.getElementById('stats')!;
const feedEl = document.getElementById('feed') as HTMLDivElement;
const feedPanel = document.getElementById('feed-panel')!;
const popover = document.getElementById('popover')!;
const rowPaths = new WeakMap<HTMLLIElement, string[]>();

interface FeedGroup {
  wrap: HTMLDivElement;
  list: HTMLUListElement;
  nameEl: HTMLElement;
  dotEl: HTMLElement;
  cntEl: HTMLElement;
  rows: number;
  collapsed: boolean;
}
const feedGroups = new Map<string, FeedGroup>();
const MAX_ROWS_PER_GROUP = 200;

function feedGroupFor(sid: string): FeedGroup {
  let g = feedGroups.get(sid);
  if (g) return g;
  const wrap = document.createElement('div');
  wrap.className = 'feed-group';
  const header = document.createElement('div');
  header.className = 'feed-group-header';
  header.innerHTML =
    '<span class="chev">▾</span><span class="sdot"></span><span class="name"></span><span class="cnt"></span>';
  const list = document.createElement('ul');
  wrap.append(header, list);
  g = {
    wrap,
    list,
    nameEl: header.querySelector('.name')!,
    dotEl: header.querySelector('.sdot')!,
    cntEl: header.querySelector('.cnt')!,
    rows: 0,
    collapsed: false,
  };
  const group = g;
  header.addEventListener('click', () => {
    group.collapsed = !group.collapsed;
    group.wrap.classList.toggle('collapsed', group.collapsed);
  });
  feedGroups.set(sid, g);
  feedEl.prepend(wrap);
  return g;
}

document.getElementById('feed-toggle')!.addEventListener('click', () => {
  feedPanel.classList.toggle('hidden');
});

// ---------------------------------------------------------------- simulation

const linkForce = forceLink<GNode, GEdge>([])
  .id((d) => d.id)
  .distance((e) => EDGE_DIST[e.kind] ?? 60)
  .strength(0.5);

const EDGE_DIST: Record<string, number> = {
  'session-hub': 85,
  'hub-tool': 65,
  'tool-res': 45,
  'session-skill': 135,
  'session-agent': 155,
  'session-dir': 125,
  'dir-dir': 55,
  'dir-file': 38,
};

const sim: Simulation<GNode, GEdge> = forceSimulation<GNode>([])
  .force('link', linkForce)
  .force(
    'charge',
    forceManyBody<GNode>().strength((d) =>
      d.kind === 'file' || d.kind === 'res' ? -35 : d.kind === 'dir' ? -80 : -150,
    ),
  )
  .force('collide', forceCollide<GNode>((d) => nodeRadius(d) + 5))
  .force('cluster', clusterForce)
  .alphaDecay(0.03)
  .velocityDecay(0.35);

// We drive ticks from the render loop; d3's internal timer would otherwise race
// against nodes/edges being pushed into the shared arrays mid-turn.
sim.stop();

function clusterForce(alpha: number): void {
  for (const n of nodes) {
    const s = sessions.get(n.sid);
    if (!s || n.kind === 'session') continue;
    const strength = n.kind === 'file' || n.kind === 'res' ? 0.004 : 0.012;
    n.vx! += (s.center.x - n.x!) * strength * alpha * 10;
    n.vy! += (s.center.y - n.y!) * strength * alpha * 10;
  }
}

function kickSim(): void {
  sim.nodes(nodes);
  linkForce.links(edges);
  if (sim.alpha() < 0.35) sim.alpha(0.35);
  simDirty = false;
}

// ---------------------------------------------------------------- graph building

function addNode(partial: Omit<GNode, 'heat' | 'count' | 'lastTs' | 'children' | 'descCount' | 'events'>): GNode {
  const parent = partial.parentId ? nodeById.get(partial.parentId) : undefined;
  const px = parent?.x ?? sessions.get(partial.sid)?.center.x ?? 0;
  const py = parent?.y ?? sessions.get(partial.sid)?.center.y ?? 0;
  const node: GNode = {
    heat: 0,
    count: 0,
    lastTs: 0,
    children: 0,
    descCount: 0,
    events: [],
    x: px + (Math.random() - 0.5) * 40,
    y: py + (Math.random() - 0.5) * 40,
    ...partial,
  };
  nodes.push(node);
  nodeById.set(node.id, node);
  simDirty = true;
  return node;
}

function addEdge(a: string, b: string, kind: string): void {
  const id = `${a}->${b}`;
  if (edgeIds.has(id)) return;
  edgeIds.add(id);
  edges.push({ id, kind, source: a, target: b });
  simDirty = true;
}

function sessionCenter(index: number): { x: number; y: number } {
  const col = (index % 3) - 1;
  const row = Math.floor(index / 3);
  return { x: col * SESSION_SPACING_X, y: row * SESSION_SPACING_Y };
}

function ensureSession(ev: BrainEvent): SessionInfo {
  let s = sessions.get(ev.sid);
  if (s) {
    if (ev.cwd && s.cwd !== ev.cwd) s.cwd = ev.cwd;
    return s;
  }
  const center = sessionCenter(sessions.size);
  const base = ev.cwd ? ev.cwd.split('/').filter(Boolean).pop() ?? ev.sid : ev.sid;
  s = {
    sid: ev.sid,
    label: base,
    cwd: ev.cwd,
    center,
    state: 'active',
    lastTs: ev.t,
    activeSkills: [],
    runningAgents: [],
    agentCounter: 0,
    resourceCount: 0,
    ripples: [],
  };
  sessions.set(ev.sid, s);
  const root = addNode({ id: `s:${ev.sid}`, kind: 'session', label: base, sid: ev.sid, depth: 0 });
  root.fx = center.x;
  root.fy = center.y;
  return s;
}

function ensureHub(sid: string): GNode {
  const id = `hub:${sid}`;
  let hub = nodeById.get(id);
  if (!hub) {
    hub = addNode({ id, kind: 'hub', label: 'tools', sid, parentId: `s:${sid}`, depth: 0 });
    addEdge(`s:${sid}`, id, 'session-hub');
  }
  return hub;
}

function ensureToolNode(sid: string, tool: string): GNode {
  const hub = ensureHub(sid);
  const id = `tool:${sid}:${tool}`;
  let n = nodeById.get(id);
  if (!n) {
    n = addNode({ id, kind: 'tool', label: tool, sid, parentId: hub.id, depth: 0 });
    addEdge(hub.id, id, 'hub-tool');
  }
  return n;
}

/** Path of a file relative to the session cwd; falls back to trailing segments. */
function relSegments(cwd: string, filePath: string): string[] {
  let rel: string;
  if (cwd && filePath.startsWith(cwd.endsWith('/') ? cwd : cwd + '/')) {
    rel = filePath.slice(cwd.length).replace(/^\//, '');
  } else {
    const parts = filePath.split('/').filter(Boolean);
    rel = (parts.length > 3 ? '…/' : '') + parts.slice(-3).join('/');
  }
  return rel.split('/').filter(Boolean);
}

function ensureFileNode(s: SessionInfo, filePath: string): GNode {
  const segs = relSegments(s.cwd, filePath);
  const fileName = segs.pop() ?? filePath;
  let parentId = `s:${s.sid}`;
  let parentKind = 'session-dir';
  let depth = 0;
  let acc = '';
  for (const seg of segs) {
    acc += '/' + seg;
    depth += 1;
    const dirId = `dir:${s.sid}:${acc}`;
    let dir = nodeById.get(dirId);
    if (!dir) {
      dir = addNode({ id: dirId, kind: 'dir', label: seg, sid: s.sid, parentId, depth });
      addEdge(parentId, dirId, parentKind);
      const p = nodeById.get(parentId);
      if (p && p.kind === 'dir') p.children += 1;
    }
    parentId = dirId;
    parentKind = 'dir-dir';
  }
  const fileId = `file:${s.sid}:${acc}/${fileName}`;
  let file = nodeById.get(fileId);
  if (!file) {
    file = addNode({ id: fileId, kind: 'file', label: fileName, sid: s.sid, parentId, depth: depth + 1 });
    addEdge(parentId, fileId, parentId.startsWith('dir:') ? 'dir-file' : 'session-dir');
    const p = nodeById.get(parentId);
    if (p) p.children += 1;
    s.resourceCount += 1;
  }
  // bump aggregate counters up the dir chain for zoomed-out heat
  let walk = nodeById.get(parentId);
  while (walk && walk.kind === 'dir') {
    walk.descCount += 1;
    walk.heat = Math.min(6, walk.heat + 0.4);
    walk = walk.parentId ? nodeById.get(walk.parentId) : undefined;
  }
  return file;
}

function ensureResNode(s: SessionInfo, toolNode: GNode, key: string, label: string): GNode {
  const id = `res:${s.sid}:${toolNode.label}:${key}`;
  let n = nodeById.get(id);
  if (!n) {
    n = addNode({ id, kind: 'res', label, sid: s.sid, parentId: toolNode.id, depth: 0 });
    addEdge(toolNode.id, id, 'tool-res');
    toolNode.children += 1;
    s.resourceCount += 1;
  }
  return n;
}

/**
 * Resource shared across tools (a background task touched by Monitor AND
 * TaskStop, an agent messaged repeatedly): one node, an edge from every tool
 * that touches it.
 */
function ensureSharedRes(s: SessionInfo, toolNode: GNode, ns: string, key: string, label: string): GNode {
  const id = `res:${s.sid}:${ns}:${key}`;
  let n = nodeById.get(id);
  if (!n) {
    n = addNode({ id, kind: 'res', label, sid: s.sid, parentId: toolNode.id, depth: 0 });
    toolNode.children += 1;
    s.resourceCount += 1;
  }
  addEdge(toolNode.id, id, 'tool-res'); // deduped; links each touching tool
  return n;
}

/** Evict coldest resources when a session grows past the cap (perf guard). */
function maybeEvict(s: SessionInfo): void {
  if (s.resourceCount <= MAX_RESOURCES_PER_SESSION) return;
  const victims = nodes
    .filter((n) => n.sid === s.sid && (n.kind === 'file' || n.kind === 'res'))
    .sort((a, b) => a.heat - b.heat || a.lastTs - b.lastTs)
    .slice(0, 100);
  const victimIds = new Set(victims.map((v) => v.id));
  // unwind the aggregate counters each victim contributed to its ancestors
  for (const v of victims) {
    const parent = v.parentId ? nodeById.get(v.parentId) : undefined;
    if (parent) parent.children = Math.max(0, parent.children - 1);
    let walk = parent;
    while (walk && walk.kind === 'dir') {
      walk.descCount = Math.max(0, walk.descCount - v.count);
      walk = walk.parentId ? nodeById.get(walk.parentId) : undefined;
    }
  }
  for (let i = nodes.length - 1; i >= 0; i--) {
    if (victimIds.has(nodes[i].id)) nodes.splice(i, 1);
  }
  for (const id of victimIds) nodeById.delete(id);
  for (let i = edges.length - 1; i >= 0; i--) {
    const e = edges[i];
    const sId = typeof e.source === 'object' ? (e.source as GNode).id : String(e.source);
    const tId = typeof e.target === 'object' ? (e.target as GNode).id : String(e.target);
    if (victimIds.has(sId) || victimIds.has(tId)) {
      edgeIds.delete(e.id);
      edgeHeat.delete(e.id);
      edges.splice(i, 1);
    }
  }
  s.resourceCount -= victims.length;
  simDirty = true;
  console.log(`claudebrain: evicted ${victims.length} cold nodes from ${s.label}`);
}

// ---------------------------------------------------------------- event application

function touch(n: GNode, ev: BrainEvent, full?: string): void {
  n.count += 1;
  n.heat = Math.min(6, n.heat + 1.2);
  n.lastTs = ev.t;
  if (full) {
    n.events.push({ t: fmtTime(ev.t), full });
    if (n.events.length > MAX_NODE_EVENTS) n.events.shift();
  }
}

function firePulse(path: string[], label: string, animate: boolean): Pulse | null {
  if (!animate) return null; // replay must not light up edges as if live
  const now = performance.now();
  for (let i = 0; i < path.length - 1; i++) {
    edgeHeat.set(`${path[i]}->${path[i + 1]}`, now);
  }
  const pulse: Pulse = { path, t0: now, dur: 500 + path.length * 130, label, status: 'pending' };
  pulses.push(pulse);
  if (pulses.length > MAX_PULSES) pulses.shift();
  return pulse;
}

/** "k: v · k: v" from whatever primitive fields the input has (Monitor, TaskUpdate…). */
function compactInput(input: Record<string, unknown>, perValue: number): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(input)) {
    if (v === null || v === undefined || typeof v === 'object') continue;
    const sv = String(v);
    parts.push(`${k}: ${sv.length > perValue ? sv.slice(0, perValue) + '…' : sv}`);
  }
  return parts.join(' · ');
}

/** First string value among the given keys (case-insensitive). */
function strField(input: Record<string, unknown>, keys: string[]): string {
  for (const want of keys) {
    for (const [k, v] of Object.entries(input)) {
      if (k.toLowerCase() === want.toLowerCase() && typeof v === 'string' && v) return v;
    }
  }
  return '';
}

// Tools that operate on a background task — their target task becomes a graph node.
const TASK_TOOLS = new Set(['Monitor', 'TaskUpdate', 'TaskStop', 'TaskGet', 'TaskOutput', 'TaskCreate']);
const TASK_ID_KEYS = ['task_id', 'taskId', 'id', 'target_task_id'];

function toolSummary(tool: string, input: Record<string, unknown>): string {
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '');
  const base = (p: string) => p.split('/').filter(Boolean).pop() ?? p;
  if (tool === 'Bash') return `$ ${str('command').slice(0, 48)}`;
  if (tool === 'Skill') return `✦ ${str('skill') || str('name') || 'skill'}`;
  if (tool === 'Task' || tool === 'Agent') return `⧉ ${str('description').slice(0, 40) || 'agent'}`;
  const file = str('file_path') || str('notebook_path') || str('path');
  if (file) return `${tool} ${base(file)}`;
  if (str('pattern')) return `${tool} ${str('pattern').slice(0, 30)}`;
  if (str('url')) return `${tool} ${hostOf(str('url'))}`;
  if (str('query')) return `${tool} ${str('query').slice(0, 30)}`;
  const rest = compactInput(input, 18);
  return rest ? `${tool} ${rest}`.slice(0, 64) : tool;
}

/** Untruncated text for hover/copy: the whole command, path, pattern, or url. */
function toolFullText(tool: string, input: Record<string, unknown>): string {
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '');
  if (tool === 'Bash') return `$ ${str('command')}`;
  if (tool === 'Skill') return `✦ ${str('skill') || str('name') || 'skill'} ${str('args')}`.trim();
  if (tool === 'Task' || tool === 'Agent') return `⧉ ${str('description') || 'agent'}`;
  const file = str('file_path') || str('notebook_path') || str('path');
  if (file) {
    // every old/new line gets its own −/+ prefix so multi-line edits render
    // like a real git diff (and colorize per line in the popover)
    const pref = (text: string, sign: string) =>
      text
        .split('\n')
        .map((l) => `${sign} ${l}`)
        .join('\n');
    let out = `${tool} ${file}`;
    if (str('old_string') || str('new_string')) {
      out += `\n${pref(str('old_string'), '−')}\n${pref(str('new_string'), '+')}`;
      if (input.replace_all === true) out += '\n(replace all)';
    } else if (tool === 'Write' && str('content')) {
      out += `\n${pref(str('content'), '+')}`;
    } else if (str('edits')) {
      out += `\n${str('edits')}`;
    }
    return out;
  }
  if (str('pattern')) return `${tool} ${str('pattern')}`;
  if (str('url')) return `${tool} ${str('url')}`;
  if (str('query')) return `${tool} ${str('query')}`;
  const rest = compactInput(input, 400);
  return rest ? `${tool} — ${rest}` : tool;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.slice(0, 24);
  }
}

function applyGraph(ev: BrainEvent, animate: boolean): void {
  eventCount += 1;
  const s = ensureSession(ev);
  s.lastTs = ev.t;
  const sessionNode = nodeById.get(`s:${ev.sid}`)!;

  switch (ev.event) {
    case 'SessionStart':
      s.state = 'active';
      break;

    case 'UserPromptSubmit': {
      s.state = 'active';
      if (animate) s.ripples.push(performance.now());
      touch(sessionNode, ev, `“${ev.data.prompt ?? ''}”`);
      break;
    }

    case 'PreToolUse': {
      s.state = 'active';
      const tool = ev.data.tool ?? '?';
      const input = ev.data.input ?? {};
      const summary = toolSummary(tool, input);
      const full = toolFullText(tool, input);

      if (tool === 'Skill') {
        const name = String(input.skill ?? input.name ?? 'skill');
        const id = `skill:${ev.sid}:${name}`;
        let skill = nodeById.get(id);
        if (!skill) {
          skill = addNode({ id, kind: 'skill', label: name, sid: ev.sid, parentId: sessionNode.id, depth: 0 });
          addEdge(sessionNode.id, id, 'session-skill');
        }
        skill.active = true;
        if (!s.activeSkills.includes(id)) s.activeSkills.push(id);
        touch(skill, ev, full);
        const pulse = firePulse([sessionNode.id, id], summary, animate);
        pushPending(ev, id, pulse);
        break;
      }

      if (tool === 'Task' || tool === 'Agent') {
        s.agentCounter += 1;
        const id = `agent:${ev.sid}:${s.agentCounter}`;
        const label = String(input.description ?? 'agent').slice(0, 26);
        const agent = addNode({ id, kind: 'agent', label, sid: ev.sid, parentId: sessionNode.id, depth: 0 });
        addEdge(sessionNode.id, id, 'session-agent');
        agent.active = true;
        s.runningAgents.push(id);
        touch(agent, ev, full);
        const pulse = firePulse([sessionNode.id, id], summary, animate);
        pushPending(ev, id, pulse);
        break;
      }

      const toolNode = ensureToolNode(ev.sid, tool);
      touch(toolNode, ev, full);

      let target: GNode | null = null;
      const filePath =
        typeof input.file_path === 'string'
          ? input.file_path
          : typeof input.notebook_path === 'string'
            ? input.notebook_path
            : typeof input.path === 'string'
              ? input.path
              : '';
      if (filePath && filePath.includes('/')) {
        target = ensureFileNode(s, filePath);
      } else if (tool === 'Bash' && typeof input.command === 'string') {
        const key = input.command.trim().split(/\s+/).slice(0, 2).join(' ').slice(0, 40);
        target = ensureResNode(s, toolNode, key, key);
      } else if (TASK_TOOLS.has(tool) && strField(input, TASK_ID_KEYS)) {
        const tid = strField(input, TASK_ID_KEYS);
        target = ensureSharedRes(s, toolNode, 'task', tid, `⌖ ${tid.slice(0, 18)}`);
      } else if (tool === 'SendMessage' && typeof input.to === 'string' && input.to) {
        target = ensureSharedRes(s, toolNode, 'peer', input.to, `@ ${input.to.slice(0, 18)}`);
      } else if (typeof input.url === 'string') {
        const host = hostOf(input.url);
        target = ensureResNode(s, toolNode, host, host);
      } else if (typeof input.pattern === 'string') {
        const p = input.pattern.slice(0, 24);
        target = ensureResNode(s, toolNode, p, p);
      } else if (typeof input.query === 'string') {
        const q = input.query.slice(0, 24);
        target = ensureResNode(s, toolNode, q, q);
      }
      if (target) touch(target, ev, full);
      maybeEvict(s);

      const head = [sessionNode.id];
      const lastSkill = s.activeSkills[s.activeSkills.length - 1];
      if (lastSkill) head.push(lastSkill);
      const path = [...head, `hub:${ev.sid}`, toolNode.id, ...(target ? [target.id] : [])];
      const pulse = firePulse(path, summary, animate);
      pushPending(ev, (target ?? toolNode).id, pulse);
      break;
    }

    case 'PostToolUse': {
      const key = `${ev.sid}\0${ev.data.tool ?? '?'}`;
      const q = pending.get(key);
      const p = q?.shift();
      if (q && q.length === 0) pending.delete(key);
      if (p) {
        const isError = ev.data.isError === true;
        if (p.pulse) {
          p.pulse.status = isError ? 'err' : 'ok';
          p.pulse.resolvedT0 = performance.now();
        }
        const target = nodeById.get(p.targetId);
        if (target && isError) {
          if (animate) {
            target.flashT0 = performance.now();
            target.flashColor = COLORS.error;
          }
          target.heat = Math.min(6, target.heat + 2);
        }
        if (p.row) {
          const durMs = ev.t - p.t;
          const durEl = p.row.querySelector('.dur');
          if (durEl) durEl.textContent = durMs >= 100 ? fmtDur(durMs) : '';
          if (isError) p.row.classList.add('error');
        }
      }
      break;
    }

    case 'Notification': {
      const msg = ev.data.message ?? '';
      if (/permission|waiting|input|approve/i.test(msg)) s.state = 'attention';
      break;
    }

    case 'Stop': {
      s.state = 'waiting';
      for (const id of s.activeSkills) {
        const n = nodeById.get(id);
        if (n) n.active = false;
      }
      s.activeSkills = [];
      for (const id of s.runningAgents) {
        const n = nodeById.get(id);
        if (n) n.active = false;
      }
      s.runningAgents = [];
      break;
    }

    case 'SubagentStop': {
      const id = s.runningAgents.shift();
      if (id) {
        const n = nodeById.get(id);
        if (n) n.active = false;
      }
      break;
    }

    case 'SessionEnd':
      s.state = 'ended';
      break;
  }
}

function pushPending(ev: BrainEvent, targetId: string, pulse: Pulse | null): void {
  const key = `${ev.sid}\0${ev.data.tool ?? '?'}`;
  const arr = pending.get(key) ?? [];
  arr.push({ pulse, targetId, t: ev.t, row: null });
  if (arr.length > 20) arr.shift();
  pending.set(key, arr);
}

// ---------------------------------------------------------------- feed

function fmtTime(t: number): string {
  const d = new Date(t);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}

function fmtDur(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function feedAdd(ev: BrainEvent): void {
  const s = sessions.get(ev.sid);
  let cls = 'tool';
  let icon = '●';
  let text = '';
  let fullText = '';
  let pathIds: string[] = [];

  switch (ev.event) {
    case 'UserPromptSubmit':
      cls = 'prompt';
      icon = '▸';
      text = `“${(ev.data.prompt ?? '').slice(0, 70)}”`;
      fullText = `“${ev.data.prompt ?? ''}”`;
      pathIds = [`s:${ev.sid}`];
      break;
    case 'PreToolUse': {
      const tool = ev.data.tool ?? '?';
      const summary = toolSummary(tool, ev.data.input ?? {});
      if (tool === 'Skill') {
        cls = 'skill';
        icon = '✦';
      } else if (tool === 'Task' || tool === 'Agent') {
        cls = 'agent';
        icon = '⧉';
      }
      text = summary;
      fullText = toolFullText(tool, ev.data.input ?? {});
      pathIds = [`s:${ev.sid}`, `hub:${ev.sid}`, `tool:${ev.sid}:${tool}`];
      break;
    }
    case 'PostToolUse':
      if (ev.data.isError !== true) return;
      cls = 'error';
      icon = '✖';
      text = `${ev.data.tool} failed`;
      pathIds = [`tool:${ev.sid}:${ev.data.tool}`];
      break;
    case 'SessionStart':
      cls = 'lifecycle';
      icon = '◌';
      text = 'session started';
      break;
    case 'Stop':
      cls = 'lifecycle';
      icon = '◌';
      text = 'turn finished — waiting';
      break;
    case 'SessionEnd':
      cls = 'lifecycle';
      icon = '◌';
      text = 'session ended';
      break;
    case 'Notification':
      cls = 'lifecycle';
      icon = '◌';
      text = (ev.data.message ?? '').slice(0, 70);
      break;
    default:
      return;
  }

  const g = feedGroupFor(ev.sid);
  g.nameEl.textContent = s?.label ?? ev.sid;
  g.dotEl.className = `sdot ${s?.state ?? 'active'}`;

  const li = document.createElement('li');
  li.className = cls;
  li.innerHTML = `<span class="t"></span><span class="ic"></span><span class="tx"></span><span class="dur"></span>`;
  (li.querySelector('.t') as HTMLElement).textContent = fmtTime(ev.t);
  (li.querySelector('.ic') as HTMLElement).textContent = icon;
  (li.querySelector('.tx') as HTMLElement).textContent = text;
  if (fullText) li.title = fullText;
  rowPaths.set(li, pathIds);
  li.addEventListener('mouseenter', () => {
    highlight.ids = new Set(rowPaths.get(li));
    highlight.until = performance.now() + 2000;
  });
  li.addEventListener('click', () => {
    const last = rowPaths.get(li)?.slice(-1)[0];
    const n = last ? nodeById.get(last) : undefined;
    if (n) focusOn(n);
  });
  g.list.prepend(li);
  g.rows += 1;
  while (g.list.children.length > MAX_ROWS_PER_GROUP) g.list.lastChild?.remove();
  g.cntEl.textContent = String(g.rows);
  // most recently active session bubbles to the top
  if (feedEl.firstChild !== g.wrap) feedEl.prepend(g.wrap);

  // let PostToolUse find this row to stamp duration / error state
  if (ev.event === 'PreToolUse') {
    const q = pending.get(`${ev.sid}\0${ev.data.tool ?? '?'}`);
    const last = q?.[q.length - 1];
    if (last && last.t === ev.t) last.row = li;
  }
}

// ---------------------------------------------------------------- semantic zoom

function topDirOf(n: GNode): GNode {
  let cur: GNode | undefined = n;
  let lastDir: GNode | undefined;
  while (cur) {
    if (cur.kind === 'dir') lastDir = cur;
    cur = cur.parentId ? nodeById.get(cur.parentId) : undefined;
    if (lastDir && lastDir.depth === 1) break;
  }
  return lastDir ?? n;
}

/** The node actually drawn for n at zoom level k (semantic zoom collapse). */
function visibleProxy(n: GNode, k: number): GNode {
  if (n.kind === 'file' || n.kind === 'res') {
    const parent = n.parentId ? nodeById.get(n.parentId) : undefined;
    if (k < 0.45 && parent?.kind === 'dir') return topDirOf(n);
    if (k < 0.85 && parent && parent.children > 6) return parent.kind === 'dir' ? parent : n;
    return n;
  }
  if (n.kind === 'dir' && k < 0.45 && n.depth > 1) {
    let cur: GNode | undefined = n;
    while (cur && !(cur.kind === 'dir' && cur.depth === 1)) {
      cur = cur.parentId ? nodeById.get(cur.parentId) : undefined;
    }
    return cur ?? n;
  }
  return n;
}

// ---------------------------------------------------------------- rendering

function nodeRadius(n: GNode): number {
  switch (n.kind) {
    case 'session':
      return 15;
    case 'hub':
      return 5;
    case 'tool':
      return 8 + Math.min(4, Math.log2(1 + n.count));
    case 'skill':
      return 10 + Math.min(4, Math.log2(1 + n.count));
    case 'agent':
      return 9;
    case 'dir':
      return 6 + Math.min(8, Math.log2(1 + n.descCount) * 1.6);
    default:
      return 4 + Math.min(4, Math.log2(1 + n.count));
  }
}

function nodeColor(n: GNode): string {
  return COLORS[n.kind] ?? COLORS.file;
}

let lastFrame = performance.now();
let lastHeatSweep = 0;

function frame(): void {
  const now = performance.now();
  const dt = Math.min(100, now - lastFrame);
  lastFrame = now;

  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (w < 10 || h < 10) {
    requestAnimationFrame(frame);
    return;
  }
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }

  // heat decay
  const decay = Math.exp(-dt / 9000);
  for (const n of nodes) n.heat *= decay;

  // prune cold edge-heat entries (they only matter within the 2.5s hot window)
  if (now - lastHeatSweep > 5000) {
    lastHeatSweep = now;
    for (const [id, t] of edgeHeat) {
      if (now - t > 3000) edgeHeat.delete(id);
    }
  }

  if (simDirty) kickSim();
  if (sim.alpha() > 0.005) sim.tick();
  if (autoCamera) autoFit(w, h);

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, w, h);
  ctx.setTransform(dpr * cam.k, 0, 0, dpr * cam.k, dpr * cam.x, dpr * cam.y);

  const k = cam.k;
  const hlActive = now < highlight.until;

  // ---- edges
  ctx.lineWidth = 1 / k;
  for (const e of edges) {
    const a = e.source as GNode;
    const b = e.target as GNode;
    if (typeof a !== 'object' || typeof b !== 'object') continue;
    const pa = visibleProxy(a, k);
    const pb = visibleProxy(b, k);
    if (pa === pb) continue;
    const heatT = edgeHeat.get(e.id);
    const hot = heatT !== undefined && now - heatT < 2500;
    const hl = hlActive && highlight.ids.has(a.id) && highlight.ids.has(b.id);
    const sAlpha = sessions.get(a.sid)?.state === 'ended' ? 0.35 : 1;
    if (hot || hl) {
      const age = hot ? (now - heatT!) / 2500 : 0;
      ctx.strokeStyle = COLORS.pulse;
      ctx.globalAlpha = sAlpha * (hl ? 0.9 : 0.7 * (1 - age));
      ctx.lineWidth = 1.6 / k;
    } else {
      ctx.strokeStyle = COLORS.edge;
      ctx.globalAlpha = sAlpha * 0.55;
      ctx.lineWidth = 1 / k;
    }
    ctx.beginPath();
    ctx.moveTo(pa.x!, pa.y!);
    ctx.lineTo(pb.x!, pb.y!);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // ---- session halos + ripples
  for (const s of sessions.values()) {
    const root = nodeById.get(`s:${s.sid}`);
    if (!root) continue;
    const r = nodeRadius(root);
    if (s.state === 'waiting' || s.state === 'attention') {
      const speed = s.state === 'attention' ? 350 : 900;
      const phase = (Math.sin(now / speed) + 1) / 2;
      ctx.beginPath();
      ctx.arc(root.x!, root.y!, r + 8 + phase * 5, 0, Math.PI * 2);
      ctx.strokeStyle = s.state === 'attention' ? COLORS.attention : COLORS.waiting;
      ctx.globalAlpha = 0.35 + phase * 0.45;
      ctx.lineWidth = 2 / k;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    s.ripples = s.ripples.filter((t0) => now - t0 < 1300);
    for (const t0 of s.ripples) {
      const p = (now - t0) / 1300;
      ctx.beginPath();
      ctx.arc(root.x!, root.y!, r + p * 240, 0, Math.PI * 2);
      ctx.strokeStyle = COLORS.skill;
      ctx.globalAlpha = 0.5 * (1 - p);
      ctx.lineWidth = 1.5 / k;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  // ---- nodes
  const drawn = new Set<string>();
  for (const n of nodes) {
    const proxy = visibleProxy(n, k);
    if (proxy !== n) continue; // hidden behind an aggregate
    if (drawn.has(n.id)) continue;
    drawn.add(n.id);
    const s = sessions.get(n.sid);
    const alpha = s?.state === 'ended' ? 0.35 : 1;
    const r = nodeRadius(n);
    const color = nodeColor(n);
    const glow = Math.min(1, n.heat / 3);

    ctx.globalAlpha = alpha;
    if (glow > 0.05) {
      ctx.shadowColor = color;
      ctx.shadowBlur = glow * 22;
    }
    ctx.beginPath();
    ctx.arc(n.x!, n.y!, r, 0, Math.PI * 2);
    ctx.fillStyle = '#101725';
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.globalAlpha = alpha * (0.35 + glow * 0.65 + (n.kind === 'session' || n.active ? 0.3 : 0));
    ctx.lineWidth = (n.kind === 'session' ? 2 : 1.4) / Math.sqrt(k);
    ctx.stroke();
    ctx.shadowBlur = 0;

    // inner core
    ctx.beginPath();
    ctx.arc(n.x!, n.y!, Math.max(1.5, r * 0.35), 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.globalAlpha = alpha * (0.35 + glow * 0.6);
    ctx.fill();

    // active skill / running agent ring
    if (n.active) {
      const phase = (Math.sin(now / 500) + 1) / 2;
      ctx.beginPath();
      ctx.arc(n.x!, n.y!, r + 4 + phase * 2.5, 0, Math.PI * 2);
      ctx.strokeStyle = color;
      ctx.globalAlpha = alpha * (0.4 + phase * 0.4);
      ctx.lineWidth = 1.5 / k;
      ctx.stroke();
    }

    // aggregated dir badge (child count) when collapsed
    if (n.kind === 'dir' && k < 0.85 && n.descCount > 0 && k > 0.18) {
      ctx.globalAlpha = alpha * 0.9;
      ctx.fillStyle = '#8fa0b5';
      ctx.font = `${10 / k}px ui-monospace, monospace`;
      ctx.textAlign = 'center';
      ctx.fillText(String(n.descCount), n.x!, n.y! - r - 4 / k);
    }

    // error / flash overlay
    if (n.flashT0 !== undefined && now - n.flashT0 < 900) {
      const p = (now - n.flashT0) / 900;
      ctx.beginPath();
      ctx.arc(n.x!, n.y!, r + p * 26, 0, Math.PI * 2);
      ctx.strokeStyle = n.flashColor ?? COLORS.error;
      ctx.globalAlpha = alpha * (1 - p);
      ctx.lineWidth = 2 / k;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // ---- pulses
  for (let i = pulses.length - 1; i >= 0; i--) {
    const pulse = pulses[i];
    const done =
      pulse.status !== 'pending'
        ? now - (pulse.resolvedT0 ?? now) > 450
        : now - pulse.t0 > pulse.dur + 10000;
    if (done) {
      pulses.splice(i, 1);
      continue;
    }
    drawPulse(pulse, now, k);
  }

  // ---- screen-space labels
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawLabels(w, h, now, drawn);

  requestAnimationFrame(frame);
}

function pulsePoints(pulse: Pulse, k: number): Array<{ x: number; y: number }> {
  const pts: Array<{ x: number; y: number }> = [];
  for (const id of pulse.path) {
    const n = nodeById.get(id);
    if (!n) continue;
    const p = visibleProxy(n, k);
    const last = pts[pts.length - 1];
    if (!last || last.x !== p.x || last.y !== p.y) pts.push({ x: p.x!, y: p.y! });
  }
  return pts;
}

function drawPulse(pulse: Pulse, now: number, k: number): void {
  const pts = pulsePoints(pulse, k);
  if (pts.length < 2) return;
  const lens: number[] = [0];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    lens.push(total);
  }
  if (total === 0) return;

  const raw = (now - pulse.t0) / pulse.dur;
  const p = Math.min(1, raw);
  const dist = p * total;
  let seg = 1;
  while (seg < lens.length - 1 && lens[seg] < dist) seg++;
  const segLen = lens[seg] - lens[seg - 1] || 1;
  const t = (dist - lens[seg - 1]) / segLen;
  const hx = pts[seg - 1].x + (pts[seg].x - pts[seg - 1].x) * t;
  const hy = pts[seg - 1].y + (pts[seg].y - pts[seg - 1].y) * t;

  const resolved = pulse.status !== 'pending';
  const fade = resolved ? Math.max(0, 1 - (now - (pulse.resolvedT0 ?? now)) / 450) : 1;
  const color = pulse.status === 'err' ? COLORS.error : COLORS.pulse;

  // trail
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.8 / k;
  const trailBack = total * 0.25;
  let remaining = trailBack;
  let cursor = dist;
  let sIdx = seg;
  ctx.globalAlpha = 0.55 * fade;
  ctx.beginPath();
  ctx.moveTo(hx, hy);
  while (remaining > 0 && sIdx >= 1) {
    const start = lens[sIdx - 1];
    const back = Math.min(remaining, cursor - start);
    const t2 = (cursor - back - start) / (lens[sIdx] - start || 1);
    const x = pts[sIdx - 1].x + (pts[sIdx].x - pts[sIdx - 1].x) * t2;
    const y = pts[sIdx - 1].y + (pts[sIdx].y - pts[sIdx - 1].y) * t2;
    ctx.lineTo(x, y);
    remaining -= back;
    cursor -= back;
    if (cursor <= start) sIdx--;
  }
  ctx.stroke();

  // head
  ctx.shadowColor = color;
  ctx.shadowBlur = 14;
  ctx.beginPath();
  ctx.arc(hx, hy, 3.2 / Math.sqrt(k), 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.95 * fade;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.globalAlpha = 1;

  // inline action label riding the pulse
  if (pulse.label && cam.k > 0.35 && (!resolved || fade > 0.4)) {
    const sx = hx * cam.k + cam.x;
    const sy = hy * cam.k + cam.y;
    const dpr = window.devicePixelRatio || 1;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = '11px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.9 * fade;
    ctx.fillText(pulse.label, sx + 10, sy - 8);
    ctx.restore();
    ctx.setTransform(dpr * cam.k, 0, 0, dpr * cam.k, dpr * cam.x, dpr * cam.y);
    ctx.globalAlpha = 1;
  }
}

function drawLabels(w: number, h: number, now: number, drawn: Set<string>): void {
  ctx.textBaseline = 'middle';
  let budget = 220;
  for (const n of nodes) {
    if (budget <= 0) break;
    if (!drawn.has(n.id)) continue;
    const k = cam.k;
    let show = false;
    let size = 11;
    let color = '#8fa0b5';
    switch (n.kind) {
      case 'session':
        show = true;
        size = 13;
        color = '#d7e2ef';
        break;
      case 'skill':
        show = true;
        color = COLORS.skill;
        break;
      case 'agent':
        show = true;
        color = COLORS.agent;
        break;
      case 'tool':
        show = k > 0.5;
        color = '#6fb9dd';
        break;
      case 'dir':
        show = k > 0.55;
        color = '#5d6f8d';
        size = 10;
        break;
      default:
        show = k > 1.05 || n.heat > 1.4;
        size = 10;
    }
    if (hoverNode === n) {
      show = true;
      color = '#ffffff';
    }
    if (!show) continue;
    const sx = n.x! * cam.k + cam.x;
    const sy = n.y! * cam.k + cam.y;
    if (sx < -100 || sx > w + 100 || sy < -50 || sy > h + 50) continue;
    const alpha = sessions.get(n.sid)?.state === 'ended' ? 0.4 : 0.9;
    ctx.font = `${n.kind === 'session' ? '600 ' : ''}${size}px ui-monospace, monospace`;
    ctx.textAlign = 'center';
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    const offset = nodeRadius(n) * cam.k + 11;
    ctx.fillText(n.label, sx, sy + offset);
    if (n.kind === 'session') {
      const s = sessions.get(n.sid);
      if (s && s.state !== 'active') {
        ctx.font = '10px ui-monospace, monospace';
        ctx.fillStyle =
          s.state === 'waiting' ? COLORS.waiting : s.state === 'attention' ? COLORS.attention : '#45536a';
        ctx.fillText(
          s.state === 'waiting' ? '· waiting for you ·' : s.state === 'attention' ? '· needs attention ·' : 'ended',
          sx,
          sy + offset + 14,
        );
      }
    }
    ctx.globalAlpha = 1;
    budget--;
  }

  statsEl.textContent = `claudebrain — ${sessions.size} session${sessions.size === 1 ? '' : 's'} · ${eventCount} events`;
}

function autoFit(w: number, h: number): void {
  if (nodes.length === 0 || w < 100 || h < 100) return;
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const n of nodes) {
    if (n.x! < minX) minX = n.x!;
    if (n.x! > maxX) maxX = n.x!;
    if (n.y! < minY) minY = n.y!;
    if (n.y! > maxY) maxY = n.y!;
  }
  const margin = 130;
  const bw = maxX - minX + margin * 2;
  const bh = maxY - minY + margin * 2;
  const feedW = feedPanel.classList.contains('hidden') ? 0 : 320;
  const availW = Math.max(150, w - feedW);
  const targetK = Math.max(0.05, Math.min(1.1, availW / bw, h / bh));
  if (!Number.isFinite(targetK)) return;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const targetX = availW / 2 - cx * targetK;
  const targetY = h / 2 - cy * targetK;
  cam.k += (targetK - cam.k) * 0.05;
  cam.x += (targetX - cam.x) * 0.05;
  cam.y += (targetY - cam.y) * 0.05;
  cam.k = Math.min(3, Math.max(0.03, cam.k));
}

function focusOn(n: GNode): void {
  autoCamera = false;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  cam.k = Math.max(cam.k, 0.9);
  cam.x = w / 2 - n.x! * cam.k;
  cam.y = h / 2 - n.y! * cam.k;
  highlight.ids = new Set([n.id]);
  highlight.until = performance.now() + 1500;
}

// ---------------------------------------------------------------- interaction

let dragging = false;
let dragMoved = false;
let dragNode: GNode | null = null;
let dragStart = { x: 0, y: 0, camX: 0, camY: 0 };

canvas.addEventListener('mousedown', (e) => {
  dragging = true;
  dragMoved = false;
  dragNode = hitTest(e.clientX, e.clientY);
  dragStart = { x: e.clientX, y: e.clientY, camX: cam.x, camY: cam.y };
  if (dragNode) canvas.style.cursor = 'grabbing';
});

window.addEventListener('mousemove', (e) => {
  if (dragging) {
    const dx = e.clientX - dragStart.x;
    const dy = e.clientY - dragStart.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) dragMoved = true;
    if (dragNode) {
      // drag the node itself; it stays pinned where dropped, springs keep edges
      const wx = (e.clientX - cam.x) / cam.k;
      const wy = (e.clientY - cam.y) / cam.k;
      dragNode.fx = wx;
      dragNode.fy = wy;
      if (dragNode.kind === 'session') {
        const s = sessions.get(dragNode.sid);
        if (s) s.center = { x: wx, y: wy }; // whole cluster follows its root
      }
      if (dragMoved) {
        autoCamera = false;
        if (sim.alpha() < 0.25) sim.alpha(0.25);
      }
      return;
    }
    if (dragMoved) autoCamera = false;
    cam.x = dragStart.camX + dx;
    cam.y = dragStart.camY + dy;
    return;
  }
  hoverNode = hitTest(e.clientX, e.clientY);
  canvas.style.cursor = hoverNode ? 'grab' : 'default';
});

window.addEventListener('mouseup', (e) => {
  if (!dragging) return;
  dragging = false;
  const n = dragNode;
  dragNode = null;
  canvas.style.cursor = hoverNode ? 'grab' : 'default';
  if (dragMoved) return;
  if (n) showPopover(n, e.clientX, e.clientY);
  else hidePopover();
});

canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    autoCamera = false;
    const k2 = Math.min(3, Math.max(0.08, cam.k * Math.exp(-e.deltaY * 0.0014)));
    const wx = (e.clientX - cam.x) / cam.k;
    const wy = (e.clientY - cam.y) / cam.k;
    cam.x = e.clientX - wx * k2;
    cam.y = e.clientY - wy * k2;
    cam.k = k2;
  },
  { passive: false },
);

window.addEventListener('dblclick', (e) => {
  if (e.target !== canvas) return;
  const n = hitTest(e.clientX, e.clientY);
  if (n && n.kind !== 'session') {
    // release a pinned node back to the simulation
    n.fx = null;
    n.fy = null;
    if (sim.alpha() < 0.25) sim.alpha(0.25);
  } else if (!n) {
    autoCamera = true;
  }
  hidePopover();
});

function hitTest(cx: number, cy: number): GNode | null {
  const wx = (cx - cam.x) / cam.k;
  const wy = (cy - cam.y) / cam.k;
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    if (visibleProxy(n, cam.k) !== n) continue;
    const r = nodeRadius(n) + 4 / cam.k;
    if (Math.hypot(n.x! - wx, n.y! - wy) <= r) return n;
  }
  return null;
}

/**
 * What lands in the clipboard: presentation prefixes are stripped so the text
 * pastes runnable — `$ ` from commands, `+ ` when every diff line is an
 * addition (Write). Real edits keep −/+ since old/new would be ambiguous.
 */
function stripForCopy(full: string): string {
  if (full.startsWith('$ ')) return full.slice(2);
  const lines = full.split('\n');
  const hasDel = lines.some((l) => l.startsWith('−'));
  const hasAdd = lines.some((l) => l.startsWith('+'));
  if (hasAdd && !hasDel) {
    return lines.map((l) => (l.startsWith('+ ') ? l.slice(2) : l === '+' ? '' : l)).join('\n');
  }
  return full;
}

async function copyText(text: string, button: HTMLElement): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    const prev = button.textContent;
    button.textContent = '✓';
    button.classList.add('copied');
    setTimeout(() => {
      button.textContent = prev;
      button.classList.remove('copied');
    }, 900);
  } catch {
    button.textContent = '✗';
  }
}

/** Escaped HTML with git-diff coloring for −/+ prefixed lines. */
function diffHtml(full: string): string {
  return full
    .split('\n')
    .map((line) => {
      const esc = escapeHtml(line);
      if (line.startsWith('−')) return `<span class="dl">${esc}</span>`;
      if (line.startsWith('+')) return `<span class="al">${esc}</span>`;
      return esc;
    })
    .join('\n');
}

function showPopover(n: GNode, cx: number, cy: number): void {
  selectedNode = n;
  const s = sessions.get(n.sid);
  const events = n.events.slice().reverse(); // newest first
  const items = events
    .map(
      (e, i) =>
        `<li data-i="${i}"><span class="t">${e.t}</span>` +
        `<span class="tx">${diffHtml(e.full)}</span>` +
        `<button class="cp" title="copy this line">⧉</button></li>`,
    )
    .join('');
  const copyAll = events.length > 0 ? `<button id="copy-all" title="copy all lines">⧉ copy all</button>` : '';
  popover.innerHTML =
    `<div class="ph"><h3>${escapeHtml(n.label)}</h3>${copyAll}</div>` +
    `<div class="meta">${n.kind} · ${n.count} event${n.count === 1 ? '' : 's'} · ${s?.label ?? ''}</div>` +
    `<ul>${items || '<li><span class="tx">no recorded events</span></li>'}</ul>`;
  popover.hidden = false;

  popover.querySelectorAll<HTMLLIElement>('li[data-i]').forEach((li) => {
    const e = events[Number(li.dataset.i)];
    (li.querySelector('.cp') as HTMLElement).addEventListener('click', (evt) => {
      evt.stopPropagation();
      void copyText(stripForCopy(e.full), evt.currentTarget as HTMLElement);
    });
  });
  const all = popover.querySelector<HTMLElement>('#copy-all');
  if (all) {
    all.addEventListener('click', (evt) => {
      // chronological order, one action per line
      const text = events
        .slice()
        .reverse()
        .map((e) => stripForCopy(e.full))
        .join('\n');
      void copyText(text, evt.currentTarget as HTMLElement);
    });
  }

  const pw = Math.min(460, window.innerWidth - 20);
  popover.style.left = `${Math.min(cx + 14, window.innerWidth - pw - 10)}px`;
  popover.style.top = `${Math.min(cy + 14, Math.max(10, window.innerHeight - 380))}px`;
}

function hidePopover(): void {
  selectedNode = null;
  popover.hidden = true;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// ---------------------------------------------------------------- websocket

const token = new URLSearchParams(location.search).get('token') ?? '';

function resetState(): void {
  nodes.length = 0;
  edges.length = 0;
  nodeById.clear();
  edgeIds.clear();
  sessions.clear();
  pulses.length = 0;
  pending.clear();
  edgeHeat.clear();
  feedEl.innerHTML = '';
  feedGroups.clear();
  eventCount = 0;
}

function connect(): void {
  const ws = new WebSocket(`ws://${location.host}/ws?token=${token}`);
  ws.onopen = () => connDot.classList.add('on');
  ws.onclose = () => {
    connDot.classList.remove('on');
    setTimeout(connect, 3000);
  };
  ws.onmessage = (msg) => {
    const data = JSON.parse(msg.data as string);
    if (data.type === 'replay') {
      resetState();
      const events: BrainEvent[] = data.events;
      for (const ev of events) applyGraph(ev, false);
      for (const ev of events.slice(-REPLAY_FEED_ROWS)) feedAdd(ev);
      // let replayed graphs settle fast
      sim.alpha(1);
    } else if (data.type === 'event') {
      const ev: BrainEvent = data.event;
      applyGraph(ev, true);
      feedAdd(ev);
    }
  };
}

connect();
requestAnimationFrame(frame);

// introspection hook for headless testing
(window as unknown as Record<string, unknown>).__debug = () => {
  const bad = nodes.filter((n) => !Number.isFinite(n.x!) || !Number.isFinite(n.y!));
  const xs = nodes.map((n) => n.x!).filter(Number.isFinite);
  const ys = nodes.map((n) => n.y!).filter(Number.isFinite);
  return {
    cam: { ...cam },
    autoCamera,
    nodes: nodes.length,
    edges: edges.length,
    badNodes: bad.map((n) => n.id),
    bbox: xs.length
      ? [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map(Math.round)
      : null,
    alpha: sim.alpha(),
    sessions: [...sessions.values()].map((s) => ({ sid: s.sid, state: s.state, center: s.center })),
    nodePos: (id: string) => {
      const n = nodeById.get(id);
      return n ? { sx: n.x! * cam.k + cam.x, sy: n.y! * cam.k + cam.y } : null;
    },
    openPopover: (id: string) => {
      const n = nodeById.get(id);
      if (n) showPopover(n, 200, 200);
      return !!n;
    },
  };
};
