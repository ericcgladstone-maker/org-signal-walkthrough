// Ask view: the optional LLM layer (src/llm). Provider, model and key
// settings; the analyst chat with streaming, tool-call transparency and
// unverified numbers highlighted; on-demand written reports; LLM content
// coding with a codebook editor and a cost estimate before anything runs.
//
// Keys live only in src/llm/keys.js createKeyStore() (memory by default,
// localStorage on explicit opt-in). The shared store keeps provider, model,
// the remember flag and the names-to-codes choice, never the key.
//
// What leaves the computer is stated in full and open by default, and must
// match what src/llm sends (analyst.js datasetContext, tools.js results with
// strings cut at 240 characters, reports.js fixed plans, coding.js text cut at
// 1,000 characters). "Replace names with codes" swaps names for codes at the
// services boundary (services/llm.js pseudonymize) and decodes answers here.

import { html, useState, useEffect, useRef, useMemo } from '../../../vendor/preact.js';
import { store, useStore } from '../store.js';
import { ViewHead, Loading, ErrorLine, Select, Flag, download, Icon, Unavailable } from '../components/common.js';
import { BarList } from '../components/charts.js';
import { renderMarkdown, markUnverified, markdownToHTMLDocument } from '../lib/markdown.js';
import { providerList, getKey, setKey, forgetKey, isRemembered, canRemember, maskKey, redact, createAnalystSession, writeReport, codingModule, estimateModule, llmModules, pseudonymize, decodeNames } from '../services/llm.js';
import { groupableAttributes, hasText, label as nodeLabel } from '../lib/dsutil.js';
import { fmtInt, fmtNum, fmtPct, humanize } from '../lib/format.js';
import { tokens } from '../lib/palette.js';

export function AskView() {
  const [providers, setProviders] = useState(null);
  const llm = useStore(s => s.llm);
  const ds = useStore(s => s.dataset);
  const [keyState, setKeyState] = useState({ has: false, masked: '', remembered: false });
  const [tab, setTab] = useState('chat');
  useEffect(() => { providerList().then(setProviders); }, []);
  const provider = providers?.find(p => p.id === llm.provider) || providers?.[0] || null;
  const refreshKey = async (p = provider) => {
    if (!p) return;
    const k = await getKey(p.id);
    setKeyState({ has: !!k, masked: k ? await maskKey(k) : '', remembered: await isRemembered(p.id) });
  };
  useEffect(() => { refreshKey(); }, [provider?.id]);
  useEffect(() => { if (providers && provider && llm.provider !== provider.id) store.set({ llm: { ...llm, provider: provider.id, model: null, key: null } }); }, [providers]);

  return html`<div class="view view--col">
    <${ViewHead} title="Ask" intro="Ask uses a user-supplied Anthropic, OpenAI, or Gemini API key to query the loaded network, draft reports, and code message content. Numerical claims are checked against results returned by the analysis engine. The provider receives the information required for the requested operation, as described below." />
    ${providers === null ? html`<${Loading}>Loading providers</${Loading}>` : !providers.length ? html`<${Unavailable}>The LLM layer (src/llm) is not available in this build. Everything else in Org Signal works without it.</${Unavailable}>` : html`
      <${ProviderSettings} providers=${providers} provider=${provider} keyState=${keyState} onKeyChange=${() => refreshKey()} />
      ${!keyState.has ? html`<${NoKey} />` : !ds ? html`<p class="text2" style="margin-top:1rem">Load data first; the model answers questions about the loaded network.</p>` : html`
        <div class="tabs" role="tablist" aria-label="Language model tools" style="margin-top:1.5rem">
          ${[['chat', 'Analyst'], ['report', 'Reports'], ['coding', 'Content coding']].map(([id, l]) => html`<button type="button" role="tab" aria-selected=${String(tab === id)} onClick=${() => setTab(id)}>${l}</button>`)}
        </div>
        <div role="tabpanel">
          ${tab === 'chat' && html`<${Chat} provider=${provider} ds=${ds} />`}
          ${tab === 'report' && html`<${Reports} provider=${provider} ds=${ds} />`}
          ${tab === 'coding' && html`<${Coding} provider=${provider} ds=${ds} />`}
        </div>`}
    `}
  </div>`;
}

function NoKey() {
  return html`<section class="section" aria-label="Language-model functions">
    <h2 class="section__title">Language-model functions</h2>
    <div class="prose small">
      <p>An API key enables three language-model functions. Network calculations continue to come from the Org Signal analysis engine.</p>
      <ul class="can-list" style="margin-top:.6rem">
        <li><strong>Analyst.</strong> Ask questions about the loaded network in ordinary language. The model can request computed results from the analysis engine and must cite numerical claims to those results. Unsupported numerical claims are flagged.</li>
        <li><strong>Reports.</strong> Generate a written report for the whole network, a group attribute, or a selected person from a fixed set of computed results.</li>
        <li><strong>Content coding.</strong> Apply a user-defined codebook to a sample of messages. Double-coding can be used to estimate agreement.</li>
      </ul>
      <p style="margin-top:.8rem">Usage is billed by the provider. A cost estimate is shown before each report or coding run.</p>
    </div>
  </section>`;
}

function ProviderSettings({ providers, provider, keyState, onKeyChange }) {
  const llm = useStore(s => s.llm);
  const [draft, setDraft] = useState('');
  const [remember, setRemember] = useState(!!llm.remember);
  const [models, setModels] = useState(null);
  const [modelsErr, setModelsErr] = useState(null);
  const [canRem, setCanRem] = useState(false);
  useEffect(() => { canRemember().then(setCanRem); }, []);
  useEffect(() => { setRemember(keyState.remembered || !!llm.remember); }, [keyState.remembered]);
  useEffect(() => {
    setModels(null); setModelsErr(null);
    if (!provider || !keyState.has) return;
    let live = true;
    getKey(provider.id).then(key => provider.listModels({ key })).then(m => { if (live) setModels(m || []); }, async e => { if (live) setModelsErr(await redact(e.message)); });
    return () => { live = false; };
  }, [provider?.id, keyState.has]);
  const model = llm.model || provider?.defaultModel;
  const save = async () => {
    if (!draft.trim()) return;
    await setKey(provider.id, draft.trim(), remember);
    setDraft('');
    store.set({ llm: { ...llm, remember, key: null } });
    onKeyChange();
  };
  const forget = async () => { await forgetKey(provider.id); store.set({ llm: { ...llm, remember: false, key: null } }); onKeyChange(); };
  const modelOptions = models?.length ? models.map(m => ({ value: m.id, label: m.label || m.id })) : [{ value: model, label: model }];
  if (models?.length && !models.some(m => m.id === model)) modelOptions.unshift({ value: model, label: `${model} (default)` });
  return html`<section class="section" style="border-top:0" aria-labelledby="prov-h">
    <h2 id="prov-h" class="section__title">Provider and API key</h2>
    <div class="grid-2">
      <${Select} label="Provider" value=${provider?.id} onChange=${v => store.set({ llm: { ...llm, provider: v, model: null, key: null } })} options=${providers.map(p => ({ value: p.id, label: p.label }))} />
      <${Select} label="Model" value=${model} onChange=${v => store.set({ llm: { ...llm, model: v, key: null } })} options=${modelOptions} disabled=${!keyState.has} />
    </div>
    ${modelsErr && html`<p class="small text2" style="margin-top:.4rem"><${Flag} level="caution" /> Could not list models: ${modelsErr}</p>`}
    ${keyState.has ? html`<div class="row" style="margin-top:.9rem">
        <span class="small text2">Key ${keyState.masked} ${keyState.remembered ? 'is remembered in this browser (local storage) until you forget it' : 'is held in memory for this tab only and is gone when you close it'}.</span>
        <button type="button" class="tlink tlink--quiet" onClick=${forget}>Forget key</button>
      </div>`
      : html`<form class="stack" style="margin-top:.9rem" onSubmit=${e => { e.preventDefault(); save(); }}>
        <label class="field"><span>API key for ${provider?.label}${provider?.keyUrl ? html` · <a href=${provider.keyUrl} target="_blank" rel="noopener noreferrer">get one</a>` : ''}</span>
          <input class="input" type="password" autocomplete="off" spellcheck="false" placeholder=${provider?.keyPlaceholder || ''} value=${draft} onInput=${e => setDraft(e.currentTarget.value)} /></label>
        <label class="check"><input type="checkbox" checked=${remember} disabled=${!canRem} onChange=${e => setRemember(e.currentTarget.checked)} />Remember the key in this browser</label>
        <p class="basis">${remember ? html`<span style="color:var(--warn)"><${Flag} level="caution" /> The key will be kept in this browser's local storage, where anyone using this browser profile, and any extension allowed on this page, can read it. Leave this off on shared computers.</span>` : canRem ? 'Off: the key is held in memory for this tab only and is gone when you close it. On: it is kept in this browser\'s local storage until you forget it.' : 'This browser does not allow local storage here, so the key is held in memory for this tab only.'}</p>
        <div><button class="btn btn--primary" type="submit" disabled=${!draft.trim()}>Use this key</button></div>
      </form>`}
    <${WhatIsSent} provider=${provider} />
  </section>`;
}

// What leaves this computer. Open by default (D8, S5) and kept in step with
// src/llm: analyst.js sends the question, the dataset description and tool
// results; tools.js cuts strings at 240 characters and lists at 50; edge
// evidence returns 10 events by default; reports.js runs a fixed plan with no
// tie evidence; coding.js sends only sampled message text cut at 1,000.
function WhatIsSent({ provider }) {
  const llm = useStore(s => s.llm);
  const codes = llm.codes !== false;
  const demo = provider?.id === 'demo';
  return html`<details class="disclose" open style="margin-top:1.25rem">
    <summary>What is sent to the model provider</summary>
    <div class="prose small" style="padding:.4rem 0 .6rem">
      <p>${demo ? 'The offline demo provider answers inside this tab, so nothing is sent while it is selected. With a real provider: ' : ''}When a language-model function is run, the browser sends the request directly to the selected provider. The information sent depends on the operation and is listed below. Original files remain in the browser.</p>
      <ul class="can-list" style="margin-top:.6rem">
        <li><strong>Analyst.</strong> The request can include the conversation, a description of the dataset and construction settings, computed results requested by the model, and short excerpts from underlying records when the question requires evidence for a tie.</li>
        <li><strong>Reports.</strong> Reports use a fixed set of computed network, person, group, temporal, and content results. Message text is excluded except for the aggregate word results used by the report.</li>
        <li><strong>Content coding.</strong> The provider receives the codebook and the sampled message text used for coding.</li>
        <li><strong>API key.</strong> The key is sent directly to the selected provider with each request.</li>
      </ul>
      <label class="check" style="margin-top:.8rem;align-items:flex-start"><input type="checkbox" checked=${codes} onChange=${e => store.set({ llm: { ...store.get().llm, codes: e.currentTarget.checked } })} style="margin-top:.2rem" />
        <span>Replace names with codes before sending. People become P1, P2 and so on; their names in message excerpts, words and questions are replaced too, email addresses are removed, and name, email, phone and manager columns are left out. Answers are turned back into names on this computer. Nicknames, misspellings and people who are not in the data are not caught.</span></label>
      <p style="margin-top:.8rem">Sending this content to a provider may require consent, contractual permission, or ethics approval for the data concerned.</p>
    </div>
  </details>`;
}

// ---- analyst chat ---------------------------------------------------------------------

function Chat({ provider, ds }) {
  const llm = useStore(s => s.llm);
  const [turns, setTurns] = useState([]); // { role, text, result?, tools: [], streaming }
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [est, setEst] = useState(null);
  const session = useRef(null);
  const ctrl = useRef(null);
  const net = useStore(s => s.network);
  const codes = llm.codes !== false;
  useEffect(() => { session.current = null; setTurns([]); }, [provider.id, llm.model, net?.version, codes]);
  useEffect(() => {
    (async () => {
      const m = await llmModules();
      if (!m.estimate?.estimateAsk) return setEst(null);
      setEst(m.estimate.estimateAsk({ provider: provider.id, model: llm.model || provider.defaultModel, systemPrompt: m.analyst?.ANALYST_SYSTEM_PROMPT || '', tools: m.tools?.TOOL_DEFINITIONS || [], steps: 4 }));
    })();
  }, [provider.id, llm.model]);

  const ask = async (question) => {
    if (!question.trim() || busy) return;
    setErr(null); setBusy(true);
    const key = await getKey(provider.id);
    const model = llm.model || provider.defaultModel;
    const idx = turns.length + 1;
    setTurns(t => [...t, { role: 'user', text: question }, { role: 'assistant', text: '', tools: [], streaming: true }]);
    setQ('');
    ctrl.current = new AbortController();
    try {
      if (!session.current) session.current = await createAnalystSession({ provider, key, model, dataset: ds, codes });
      const upd = fn => setTurns(t => t.map((x, i) => (i === idx ? fn(x) : x)));
      const r = await session.current.ask(question, {
        signal: ctrl.current.signal,
        onText: d => upd(x => ({ ...x, text: x.text + d })),
        onToolCall: c => upd(x => ({ ...x, tools: [...x.tools, { name: c.name, args: c.arguments, pending: true }] })),
        onToolResult: rec => upd(x => ({ ...x, tools: x.tools.map(tl => (tl.pending && tl.name === rec.name ? { ...rec, pending: false } : tl)) })),
      });
      upd(x => ({ ...x, streaming: false, result: r }));
    } catch (e) {
      const msg = await redact(e?.message || String(e));
      setTurns(t => t.map((x, i) => (i === idx ? { ...x, streaming: false, error: e.name === 'AbortError' || e.code === 'aborted' ? 'Stopped.' : msg } : x)));
    } finally { setBusy(false); }
  };
  const suggestions = ['Who are the brokers between departments, and how sure can we be?', 'Is clustering here higher than in random networks with the same degrees?', 'How did activity change over time?'];
  return html`<div class="chat">
    ${!turns.length && html`<div class="prose small"><p>Ask about structure, positions, groups, change over time or content. The analyst answers only from computed results, cites each with a marker like [T2], and says when a measure does not apply to this data.</p>
      <p class="label" style="margin-top:1rem">Try</p>
      <ul class="ask-try">${suggestions.map(s => html`<li><button type="button" class="tlink tlink--quiet" onClick=${() => ask(s)}>${s}</button></li>`)}</ul></div>`}
    ${turns.map((t, i) => (t.role === 'user'
      ? html`<div class="msg msg--user" key=${i}><div class="msg__who">You</div><div class="msg__text">${t.text}</div></div>`
      : html`<${Answer} key=${i} turn=${t} ds=${codes ? ds : null} />`))}
    <${ErrorLine} error=${err} />
    <form class="stack" onSubmit=${e => { e.preventDefault(); ask(q); }}>
      <label class="field"><span>Question</span><textarea id="ask-q" class="input" rows="3" value=${q} onInput=${e => setQ(e.currentTarget.value)} onKeyDown=${e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); ask(q); } }} placeholder="For example: which teams are most cut off from each other?"></textarea></label>
      <div class="row">
        <button class="btn btn--primary" type="submit" disabled=${busy || !q.trim()}>Ask</button>
        ${busy && html`<button class="tlink tlink--quiet" type="button" onClick=${() => ctrl.current?.abort()}>Stop</button>`}
        ${turns.length > 0 && !busy && html`<button class="tlink tlink--quiet" type="button" onClick=${() => { session.current?.reset?.(); session.current = null; setTurns([]); store.actions.focus('#ask-q'); }}>New conversation</button>`}
        <span class="meta grow" style="text-align:right">${est?.usd != null ? `About ${fmtUSD(est.usd)} to ${fmtUSD(est.usdHigh)} per question` : ''}</span>
      </div>
      ${est?.note && html`<p class="basis">${est.note}</p>`}
    </form>
  </div>`;
}

// Download and confirm (D17).
function saveFile(text, filename, mime) {
  download(text, filename, mime);
  store.actions.notify('info', `Downloaded ${filename}.`);
}

function fmtUSD(x) { if (x == null) return 'unknown'; if (x < 0.01) return 'under $0.01'; return `$${x.toFixed(x < 1 ? 3 : 2)}`; }

// ds is set when names were sent as codes: the answer is decoded for display.
function Answer({ turn, ds }) {
  const [open, setOpen] = useState(null);
  const r = turn.result;
  const results = r?.toolResults || [];
  const dec = t => (ds ? decodeNames(t, ds) : t);
  const text = dec(r ? markUnverified(r.text, r.unverifiedNumbers) : turn.text);
  const onCite = (id) => setOpen(o => (o === id ? null : id));
  const sel = results.find(x => x.id === open);
  return html`<div class="msg">
    <div class="msg__who">Analyst${turn.streaming ? html` <span class="spinner" aria-hidden="true"></span>` : ''}</div>
    ${turn.tools?.length > 0 && turn.streaming && html`<p class="meta" style="margin-bottom:.4rem">${turn.tools.map(t => `${t.pending ? 'calling' : 'called'} ${t.name}`).join(' · ')}</p>`}
    <div aria-live="polite">${r ? renderMarkdown(text, { onCite }) : html`<div class="msg__text">${text}</div>`}</div>
    ${sel && html`<div style="margin-top:.6rem"><p class="label">${sel.id}: ${sel.name}(${JSON.stringify(sel.args || {})})</p><pre class="code">${prettyJSON(sel.content)}</pre></div>`}
    ${turn.error && html`<${ErrorLine} error=${turn.error} />`}
    ${r && html`
      ${r.unverifiedNumbers?.length > 0 ? html`<p class="small" style="margin-top:.6rem;color:var(--warn)"><${Flag} level="caution" /> ${r.unverifiedNumbers.length} number${r.unverifiedNumbers.length > 1 ? 's' : ''} in this answer (underlined) did not come from a computed result. Do not rely on ${r.unverifiedNumbers.length > 1 ? 'them' : 'it'}.</p>`
        : html`<p class="basis">Every number in this answer matches a computed result.</p>`}
      ${r.refused && html`<p class="small text2"><${Flag} level="info" /> The model declined part of this request.</p>`}
      ${results.length > 0 && html`<details class="disclose"><summary>Computed values used (${results.length}), as sent</summary>
        ${results.map(x => html`<div style="margin:.4rem 0"><p class="label" style="margin:0">${x.id} · ${x.name}(${JSON.stringify(x.args || {})})${x.error ? ' · error' : ''}</p><pre class="code">${prettyJSON(x.content)}</pre></div>`)}
      </details>`}`}
  </div>`;
}

function prettyJSON(s) {
  try { return JSON.stringify(typeof s === 'string' ? JSON.parse(s) : s, null, 2); } catch { return String(s); }
}

// ---- reports ----------------------------------------------------------------------------

function Reports({ provider, ds }) {
  const llm = useStore(s => s.llm);
  const attrs = groupableAttributes(ds);
  const sel = useStore(s => s.selection);
  const [scope, setScope] = useState('network');
  const [target, setTarget] = useState(attrs[0]?.key || '');
  const [node, setNode] = useState(sel[0] != null ? String(sel[0]) : '');
  const codes = llm.codes !== false;
  const dec = t => (codes ? decodeNames(t, ds) : t);
  const [est, setEst] = useState(null);
  const [out, setOut] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const ctrl = useRef(null);
  const model = llm.model || provider.defaultModel;
  useEffect(() => {
    (async () => {
      const m = await llmModules();
      const sections = m.reports?.REPORT_SECTIONS?.[scope]?.length || 6;
      setEst(m.estimate?.estimateReport ? m.estimate.estimateReport({ provider: provider.id, model, systemPrompt: m.reports?.REPORT_SYSTEM_PROMPT || '', resultsText: 'x'.repeat(14000), sections }) : null);
    })();
  }, [scope, provider.id, model]);
  const run = async () => {
    setBusy(true); setErr(null); setOut({ markdown: '', streaming: true });
    ctrl.current = new AbortController();
    try {
      const key = await getKey(provider.id);
      const r = await writeReport({ scope, target: scope === 'group' ? target : scope === 'node' ? Number(node) : undefined, provider, key, model, dataset: ds, codes, signal: ctrl.current.signal, onText: d => setOut(o => ({ ...o, markdown: (o?.markdown || '') + d })) });
      // Decode once, after the citation check (which ran on what was sent).
      setOut({ ...r, markdown: dec(markUnverified(r.markdown, r.unverifiedNumbers)), marked: true, title: dec(r.title), streaming: false });
      store.actions.focus('#report-out');
    } catch (e) { setErr(await redact(e.message)); setOut(null); } finally { setBusy(false); }
  };
  const nodeOptions = useMemo(() => {
    const ids = [...new Set([...sel, ...Array.from({ length: Math.min(ds.nodes.count, 400) }, (_, i) => i)])];
    return ids.map(i => ({ value: String(i), label: nodeLabel(ds, i) }));
  }, [ds, sel]);
  return html`<div class="stack">
    <p class="small text2">A report is written from a fixed plan of computed results (listed at the end of the report), section by section. Numbers are checked against those results.</p>
    <div class="grid-2">
      <${Select} label="Report on" value=${scope} onChange=${setScope} options=${[{ value: 'network', label: 'The whole network' }, { value: 'group', label: 'A group attribute' }, { value: 'node', label: 'One person' }]} />
      ${scope === 'group' && html`<${Select} label="Attribute" value=${target} onChange=${setTarget} options=${attrs.length ? attrs.map(a => ({ value: a.key, label: a.label })) : [{ value: '', label: 'No attributes in this data' }]} />`}
      ${scope === 'node' && html`<${Select} label="Person" value=${node} onChange=${setNode} options=${nodeOptions} />`}
    </div>
    ${est && html`<p class="small text2">Estimated cost ${fmtUSD(est.usd)} to ${fmtUSD(est.usdHigh)}. <span class="basis">${est.note}</span></p>`}
    <div class="row"><button type="button" class="btn btn--primary" onClick=${run} disabled=${busy || (scope === 'group' && !target) || (scope === 'node' && !node)}>Write report</button>${busy && html`<button type="button" class="tlink tlink--quiet" onClick=${() => ctrl.current?.abort()}>Stop</button>`}</div>
    <${ErrorLine} error=${err} />
    ${out && html`<div class="section" id="report-out" tabindex="-1">
      ${out.streaming ? html`<div class="msg__text">${dec(out.markdown)}</div>` : renderMarkdown(out.markdown)}
      ${!out.streaming && html`
        ${out.unverifiedNumbers?.length > 0 ? html`<p class="small" style="color:var(--warn)"><${Flag} level="caution" /> ${out.unverifiedNumbers.length} number(s) (underlined) are not in the computed results.</p>` : html`<p class="basis">Every number matches a computed result.</p>`}
        ${out.missingSections?.length > 0 && html`<p class="small text2">Sections the model left out were added as placeholders: ${out.missingSections.join(', ')}.</p>`}
        <div class="tlinks" style="margin-top:.8rem">
          <button type="button" class="tlink tlink--down" onClick=${() => saveFile(out.markdown.replace(/[\u0001\u0002]/g, ''), 'report.md', 'text/markdown')}>Markdown</button>
          <button type="button" class="tlink tlink--down" onClick=${() => saveFile(markdownToHTMLDocument(out.markdown, out.title), 'report.html', 'text/html')}>HTML (prints to PDF)</button>
        </div>`}
    </div>`}
  </div>`;
}

// ---- content coding -----------------------------------------------------------------------

const DEFAULT_CODEBOOK = {
  name: 'Coordination talk', multiLabel: false, instructions: '',
  codes: [
    { id: 'request', label: 'Request', definition: 'Asks someone to do something or for information.' },
    { id: 'inform', label: 'Inform', definition: 'Shares information, status or an update without asking for anything.' },
    { id: 'social', label: 'Social', definition: 'Greeting, thanks, praise or other relationship talk.' },
  ],
};

function Coding({ provider, ds }) {
  const llm = useStore(s => s.llm);
  const [cb, setCb] = useState(DEFAULT_CODEBOOK);
  const [size, setSize] = useState(200);
  const [strata, setStrata] = useState('context');
  const [doubleCode, setDouble] = useState(false);
  const [sample, setSample] = useState(null);
  const [est, setEst] = useState(null);
  const [res, setRes] = useState(null);
  const [err, setErr] = useState(null);
  const [mod, setMod] = useState(undefined);
  const [busy, setBusy] = useState(false);
  const model = llm.model || provider.defaultModel;
  // With codes on, the coder reads message text with the data's names replaced.
  const sendDs = llm.codes !== false ? pseudonymize(ds).ds : ds;
  useEffect(() => { codingModule().then(setMod); }, []);
  useEffect(() => { if (sample && mod?.estimateCoding) setEst(mod.estimateCoding({ provider: provider.id, model, ds, sample, codebook: cb, batchSize: 20, doubleCode })); }, [doubleCode, model, cb]);
  const errors = mod?.validateCodebook ? mod.validateCodebook(cb) : [];
  if (mod === undefined) return html`<${Loading} />`;
  if (!mod) return html`<${Unavailable}>Content coding (src/llm/coding.js) is not available in this build.</${Unavailable}>`;
  if (!hasText(ds)) return html`<p class="text2">This data has no message text to code.</p>`;
  const draw = () => {
    setErr(null); setRes(null);
    try {
      const s = mod.sampleMessages(ds, { size, strata: strata || null, seed: 1 });
      setSample(s);
      setEst(mod.estimateCoding({ provider: provider.id, model, ds, sample: s, codebook: cb, batchSize: 20, doubleCode }));
    } catch (e) { setErr(e); }
  };
  const run = async () => {
    setBusy(true); setErr(null);
    try {
      const key = await getKey(provider.id);
      const r = await store.actions.runJob('Coding messages', (signal, progress) => mod.codeMessages({ provider, key, model, ds: sendDs, sample, codebook: cb, batchSize: 20, doubleCode, signal, onProgress: p => progress(((p.pass - 1) + p.done / p.total) / (doubleCode ? 2 : 1), `pass ${p.pass}: ${p.done} of ${p.total}`) }));
      setRes(r);
      store.actions.focus('#cres-h');
    } catch (e) { if (e.name !== 'AbortError') setErr(await redact(e.message)); } finally { setBusy(false); }
  };
  const setCode = (i, patch) => setCb(c => ({ ...c, codes: c.codes.map((x, j) => (j === i ? { ...x, ...patch } : x)) }));
  const counts = res ? cb.codes.map(c => ({ label: c.label || c.id, value: res.results.filter(r => r.codes?.includes(c.id)).length })) : [];
  const t = tokens();
  const exportCSV = () => {
    const rows = [['event', 'codes', ...(doubleCode ? ['codes_second'] : []), 'text']];
    for (const r of res.results) rows.push([r.event, (r.codes || []).join('|'), ...(doubleCode ? [(r.codesB || []).join('|')] : []), String(ds.events.text[r.event] || '').replace(/\s+/g, ' ')]);
    saveFile(rows.map(r => r.map(x => { const s = String(x ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(',')).join('\n'), 'coded-messages.csv', 'text/csv');
  };
  return html`<div class="stack">
    <p class="small text2">Codes are defined, a stratified sample is drawn, and the cost is estimated before the run. Only message text is sent, with no names, ids, channels, or times attached. Double-coding runs the sample twice in a different order and reports agreement as an estimate of coding reliability.</p>
    <section aria-labelledby="cb-h">
      <h3 id="cb-h" class="label">Codebook</h3>
      <div class="grid-2">
        <label class="field"><span>Name</span><input class="input" value=${cb.name} onInput=${e => setCb(c => ({ ...c, name: e.currentTarget.value }))} /></label>
        <label class="check" style="align-self:end"><input type="checkbox" checked=${cb.multiLabel} onChange=${e => setCb(c => ({ ...c, multiLabel: e.currentTarget.checked }))} />A message may get several codes</label>
      </div>
      <label class="field" style="margin-top:.6rem"><span>Instructions for the coder (optional)</span><textarea class="input" rows="2" value=${cb.instructions} onInput=${e => setCb(c => ({ ...c, instructions: e.currentTarget.value }))}></textarea></label>
      <div style="margin-top:.6rem">
        ${cb.codes.map((c, i) => html`<div class="grid-3" style="padding:.6rem 0;border-top:1px solid var(--rule);gap:.5rem 1rem">
          <label class="field"><span>Id</span><input class="input" value=${c.id} onInput=${e => setCode(i, { id: e.currentTarget.value })} /></label>
          <label class="field"><span>Label</span><input class="input" value=${c.label} onInput=${e => setCode(i, { label: e.currentTarget.value })} /></label>
          <label class="field" style="grid-column:1/-1"><span>Definition</span><input class="input" value=${c.definition} onInput=${e => setCode(i, { definition: e.currentTarget.value })} /></label>
          <label class="field" style="grid-column:1/-1"><span>Examples (one per line, optional)</span><textarea class="input" rows="2" value=${(c.examples || []).join('\n')} onInput=${e => setCode(i, { examples: e.currentTarget.value.split('\n').filter(Boolean) })}></textarea></label>
          <div><button type="button" class="tlink tlink--quiet" onClick=${() => { setCb(x => ({ ...x, codes: x.codes.filter((_, j) => j !== i) })); store.actions.focus('#cb-add'); }}>Remove code</button></div>
        </div>`)}
        <button type="button" id="cb-add" class="tlink" onClick=${() => setCb(x => ({ ...x, codes: [...x.codes, { id: `code${x.codes.length + 1}`, label: '', definition: '' }] }))}>Add a code</button>
      </div>
      ${errors.length > 0 && html`<ul class="can-list" style="margin-top:.6rem">${errors.map(e => html`<li style="color:var(--warn)">${e}</li>`)}</ul>`}
    </section>
    <section class="section" aria-labelledby="smp-h">
      <h3 id="smp-h" class="label">Sample</h3>
      <div class="grid-3">
        <label class="field"><span>Messages</span><input class="input tnum" type="number" min="10" max="5000" value=${size} onInput=${e => setSize(Math.max(10, Number(e.currentTarget.value) || 200))} /></label>
        <${Select} label="Spread across" value=${strata} onChange=${setStrata} options=${[{ value: 'context', label: 'Channels and threads' }, { value: 'actor', label: 'People' }, { value: 'month', label: 'Months' }, { value: 'source', label: 'Sources' }, { value: '', label: 'No strata (simple random)' }]} />
        <label class="check" style="align-self:end"><input type="checkbox" checked=${doubleCode} onChange=${e => setDouble(e.currentTarget.checked)} />Double-code for agreement</label>
      </div>
      <div class="row" style="margin-top:.6rem"><button type="button" class="tlink" onClick=${draw} disabled=${errors.length > 0}>Draw sample and estimate</button></div>
      ${sample && html`<p class="small text2" style="margin-top:.5rem">${fmtInt(sample.size ?? sample.events.length)} messages drawn from ${fmtInt(sample.population)} eligible, across ${fmtInt(Object.keys(sample.strata || {}).length)} strata (seed ${sample.seed}).</p>`}
      ${est && html`<p class="small text2">${fmtInt(est.calls)} requests. Estimated cost ${fmtUSD(est.usd)} to ${fmtUSD(est.usdHigh)}. <span class="basis">${est.note}</span></p>`}
      ${sample && html`<div class="row" style="margin-top:.4rem"><button type="button" class="btn btn--primary" onClick=${run} disabled=${busy || errors.length > 0}>Run coding</button></div>`}
    </section>
    <${ErrorLine} error=${err} />
    ${res && html`<section class="section" aria-labelledby="cres-h">
      <h3 id="cres-h" class="section__title" tabindex="-1">Results</h3>
      <div style="max-width:40rem"><${BarList} title="Messages per code" color=${t.cat[0]} rows=${counts} format=${fmtInt} /></div>
      <dl class="kv" style="max-width:30rem;margin-top:.8rem">
        <dt>Coded</dt><dd>${fmtInt(res.results.length - res.uncoded)}</dd>
        <dt>Not coded (failed or empty)</dt><dd>${fmtInt(res.uncoded)}</dd>
        <dt>Codes outside the codebook, dropped</dt><dd>${fmtInt(res.droppedCodes)}</dd>
        ${res.agreement && Object.entries(res.agreement).filter(([, v]) => typeof v === 'number').map(([k, v]) => html`<dt>${humanize(k)}</dt><dd>${fmtNum(v, { digits: 3 })}</dd>`)}
      </dl>
      ${res.agreement && html`<p class="basis">Agreement between two independent passes. Kappa below about 0.6 means the codes are not applied consistently; refine the definitions before using the counts.</p>`}
      ${res.errors?.length > 0 && html`<p class="small" style="color:var(--warn)"><${Flag} level="caution" /> ${res.errors.length} batch(es) failed: ${res.errors.slice(0, 3).map(e => e.message).join('; ')}</p>`}
      <div class="tlinks" style="margin-top:.6rem"><button type="button" class="tlink tlink--down" onClick=${exportCSV}>Coded messages (CSV)</button></div>
    </section>`}
  </div>`;
}
