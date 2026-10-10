// The CRDT explorer: three documents of one schema, in this page, on the library build the site ships (../dist/, the
// same copy the demo imports). "origin" runs the shared calls; replica A and B merge its snapshot, run their own calls
// "offline", then merge each other's snapshot - the exchange attach() performs over a data channel after the hello.
// The editors take calls as JSON, ["method", ...arguments], so what runs is the library API itself, not a model of it.
// VERIFIED: every preset converges, with the outcome its note states (node run of these calls on docs/dist, 2026-10-10).
import { createCrdtDocument, defineSchema, register, counter, orSet, map, object, list } from '../dist/index.js';
import { jsonLines } from './json.js';

const $ = (id) => document.getElementById(id);

const schema = defineSchema({
  title: register('Untitled'),
  votes: counter(0),
  tags: orSet([]),
  todos: map(object({ text: register(''), done: register(false) })),
  messages: list([]),
});
const METHODS = new Set(['set', 'increment', 'setAdd', 'setDelete', 'mapDelete', 'listInsert', 'listSet', 'listDelete']);

const PRESETS = {
  mixed: {
    note: 'Every rule at once: the title is a register, the votes a counter, the tags a set, the todos a map, the messages a list. Change any call and merge again.',
    base: [['set', ['title'], 'Shopping list'], ['increment', ['votes'], 1], ['setAdd', ['tags'], 'p2p'], ['set', ['todos', 'milk', 'text'], 'Buy milk'], ['listInsert', ['messages'], 0, { text: 'hello' }]],
    a: [['set', ['title'], 'Groceries'], ['increment', ['votes'], 2], ['setDelete', ['tags'], 'p2p'], ['set', ['todos', 'milk', 'done'], true], ['listInsert', ['messages'], 1, { text: 'A: written offline' }]],
    b: [['set', ['title'], 'Weekend shopping'], ['increment', ['votes'], 5], ['setAdd', ['tags'], 'offline'], ['set', ['todos', 'bread', 'text'], 'Buy bread'], ['listInsert', ['messages'], 1, { text: 'B: me too' }]],
  },
  register: {
    note: 'Both replicas set the title while apart. The higher (Lamport clock, actor, seq) wins on both: the clocks are equal here, so the actor decides, and "replica-b" sorts after "replica-a".',
    base: [['set', ['title'], 'Shopping list']],
    a: [['set', ['title'], 'Groceries']],
    b: [['set', ['title'], 'Weekend shopping']],
  },
  counter: {
    note: 'Both increment the votes. Each delta is its own operation and counts once: 1 shared + 2 from A + 5 from B = 8, in any order.',
    base: [['increment', ['votes'], 1]],
    a: [['increment', ['votes'], 2]],
    b: [['increment', ['votes'], 5]],
  },
  set: {
    note: 'A deletes the tag "p2p" while B adds it again. A delete removes only the adds it has seen, so B\'s concurrent add survives: add wins.',
    base: [['setAdd', ['tags'], 'p2p']],
    a: [['setDelete', ['tags'], 'p2p']],
    b: [['setAdd', ['tags'], 'p2p'], ['setAdd', ['tags'], 'offline']],
  },
  list: {
    note: 'Both append after "hello". Every insert gets its own element id, so both messages survive, in the same order on both replicas.',
    base: [['listInsert', ['messages'], 0, { text: 'hello' }]],
    a: [['listInsert', ['messages'], 1, { text: 'A: written offline' }]],
    b: [['listInsert', ['messages'], 1, { text: 'B: me too' }]],
  },
  map: {
    note: 'A deletes the todo "milk" while B ticks it off. B\'s edit lives inside the entry A deleted, so the entry is gone on both; writing the key again would start a fresh entry.',
    base: [['set', ['todos', 'milk', 'text'], 'Buy milk']],
    a: [['mapDelete', ['todos'], 'milk']],
    b: [['set', ['todos', 'milk', 'done'], true]],
  },
  invalid: {
    note: 'A call that does not fit the schema throws before it records an operation: set() needs a register, and votes is a counter.',
    base: [['increment', ['votes'], 1]],
    a: [['set', ['votes'], 3]],
    b: [['increment', ['votes'], 5]],
  },
};

// ---- the editors: a transparent textarea over the Code Example block's own highlighted lines ---------------------------
// Keeping the textarea native keeps typing, selection, undo and accessibility the browser's; the <pre> behind it only
// paints (the defuss-dataview explorer's technique). A code-editor library would be the page's only dependency besides
// defuss-shadcn.
const editors = {};
for (const input of document.querySelectorAll('[data-editor]')) {
  const view = document.querySelector(`[data-editor-view="${input.dataset.editor}"]`);
  const sync = () => {
    view.parentElement.scrollTop = input.scrollTop;
    view.parentElement.scrollLeft = input.scrollLeft;
  };
  const paint = () => {
    view.replaceChildren(...jsonLines(input.value));
    sync();
  };
  input.addEventListener('input', () => {
    paint();
    $('ex-stale').textContent = 'Edited: merge again to update the result.';
  });
  input.addEventListener('scroll', sync);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      merge();
    }
  });
  editors[input.dataset.editor] = { input, set: (text) => { input.value = text; paint(); } };
}

/** One call per line keeps the editors readable; JSON.stringify of the whole array would print one token per line. */
const callsText = (calls) => `[\n${calls.map((call) => `  ${JSON.stringify(call)}`).join(',\n')}\n]`;

/** Object keys sorted at every level, so two states compare by content, not by insertion order. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function run(doc, key, label) {
  let calls;
  try {
    calls = JSON.parse(editors[key].input.value);
  } catch (failure) {
    throw new Error(`${label}: ${failure.message}`);
  }
  if (!Array.isArray(calls)) throw new Error(`${label}: expected an array of calls`);
  calls.forEach((call, index) => {
    if (!Array.isArray(call) || !METHODS.has(call[0])) {
      throw new Error(`${label}, call ${index + 1}: expected ["method", ...arguments] with one of ${[...METHODS].join(', ')}`);
    }
    try {
      doc[call[0]](...call.slice(1));
    } catch (failure) {
      throw new Error(`${label}, call ${index + 1} (${call[0]}): ${failure.message}`);
    }
  });
}

const show = (id, value) => $(id).replaceChildren(...jsonLines(JSON.stringify(value, null, 2)));
const converged = $('ex-converged');

function merge() {
  $('ex-stale').textContent = '';
  $('ex-error').hidden = true;
  const create = (actorId) => createCrdtDocument({ id: 'explorer', actorId, schema });
  try {
    const origin = create('origin');
    run(origin, 'base', 'shared.json');
    const a = create('replica-a');
    const b = create('replica-b');
    a.merge(origin.export());
    b.merge(origin.export());
    run(a, 'a', 'replica-a.json');
    run(b, 'b', 'replica-b.json');

    show('res-a-code', a.state);
    show('res-b-code', b.state);
    // What A sends after B's hello: every operation above B's version vector (the library's own catch-up rule).
    const vector = b.versionVector;
    show('res-wire-code', { protocol: 'defuss-crdt/1', kind: 'ops', docId: a.id, ops: a.export().ops.filter((op) => op.seq > (vector[op.actor] ?? 0)) });

    const learnedByA = a.merge(b.export());
    const learnedByB = b.merge(a.export());
    show('res-merged-code', a.state);
    const same = canonical(a.state) === canonical(b.state);
    converged.textContent = same ? 'A = B: converged' : 'A ≠ B: diverged';
    converged.dataset.variant = same ? 'default' : 'destructive';
    $('ex-counts').textContent = `B learned ${learnedByB} operation${learnedByB === 1 ? '' : 's'} from A, A learned ${learnedByA} from B; each replica now holds ${a.operationCount}.`;
  } catch (failure) {
    $('ex-error-message').textContent = failure.message;
    $('ex-error').hidden = false;
    converged.textContent = 'not merged';
    converged.dataset.variant = 'outline';
    $('ex-counts').textContent = '';
  }
}

function load(name) {
  const preset = PRESETS[name];
  editors.base.set(callsText(preset.base));
  editors.a.set(callsText(preset.a));
  editors.b.set(callsText(preset.b));
  $('ex-note').textContent = preset.note;
  for (const button of document.querySelectorAll('[data-preset]')) button.setAttribute('aria-pressed', String(button.dataset.preset === name));
  merge();
}

for (const button of document.querySelectorAll('[data-preset]')) button.addEventListener('click', () => load(button.dataset.preset));
$('ex-merge').addEventListener('click', merge);
load('mixed');
