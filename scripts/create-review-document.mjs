import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) {
  console.error("Usage: node scripts/create-review-document.mjs checklist.json review.html");
  process.exitCode = 1;
} else {
  const input = JSON.parse(await NodeFSP.readFile(inputPath, "utf8"));
  if (
    typeof input.title !== "string" ||
    !input.title.trim() ||
    input.title.length > 240 ||
    !Array.isArray(input.items) ||
    input.items.length > 200
  ) {
    throw new Error("Provide a title and up to 200 checklist items.");
  }
  const ids = new Set();
  for (const item of input.items) {
    if (
      typeof item.id !== "string" ||
      !item.id.trim() ||
      item.id.length > 128 ||
      ids.has(item.id) ||
      typeof item.title !== "string" ||
      !item.title.trim() ||
      item.title.length > 240 ||
      (item.description !== undefined &&
        (typeof item.description !== "string" || item.description.length > 4000))
    ) {
      throw new Error(
        "Each checklist item needs a unique ID, a title, and an optional description.",
      );
    }
    ids.add(item.id);
  }
  const scriptDir = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
  const sdk = (
    await NodeFSP.readFile(
      NodePath.join(scriptDir, "../examples/documents/satellite-document.js"),
      "utf8",
    )
  ).replace(
    "export function createSatelliteDocumentClient",
    "function createSatelliteDocumentClient",
  );
  const json = JSON.stringify(input).replaceAll("<", "\\u003c");
  const title = input.title
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll('"', "&quot;");
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>
:root{color-scheme:light dark;--paper:#f6f4ee;--ink:#182c3b;--muted:#52616a;--line:#c9cfcf;--accent:#164d65;--surface:#fffef9}
@media(prefers-color-scheme:dark){:root{--paper:#17232b;--ink:#edf1ec;--muted:#a4b3bb;--line:#41535e;--accent:#a7daed;--surface:#1f303b}}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.55 Georgia,serif}main{max-width:880px;margin:0 auto;padding:36px 22px 80px}header{border-top:5px solid var(--accent);padding-top:18px}h1{font-weight:500;font-size:clamp(26px,5vw,40px);line-height:1.15;margin:10px 0 16px}.eyebrow,.meta,button,select,label,textarea{font-family:ui-sans-serif,system-ui,sans-serif}.eyebrow{font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}.meta{font-size:13px;color:var(--muted)}#items{padding:0;list-style:none}li{border-top:1px solid var(--line);padding:24px 0}h2{font-weight:500;font-size:21px;margin:0 0 8px}.description{margin:0 0 14px;color:var(--muted)}label{display:block;font-size:13px;font-weight:600;margin:12px 0 5px}select,textarea{width:100%;border:1px solid var(--line);background:var(--surface);color:var(--ink);padding:10px;font-size:15px;border-radius:3px}select{max-width:240px}textarea{min-height:90px;resize:vertical}button{border:1px solid var(--accent);background:var(--accent);color:var(--paper);padding:10px 16px;font-size:14px;border-radius:3px;cursor:pointer}button.secondary{background:transparent;color:var(--accent)}button:disabled{opacity:.5;cursor:default}button:focus-visible,select:focus-visible,textarea:focus-visible{outline:3px solid var(--accent);outline-offset:3px}.actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:20px}#notice{min-height:1.6em;font:14px/1.5 ui-sans-serif,system-ui,sans-serif}#notice[data-error=true]{color:light-dark(#a12322,#ffb5ac)}[hidden]{display:none!important}
</style></head><body><main><header><div class="eyebrow">Manual verification</div><h1>${title}</h1><p>Work through each item, record what happened, and leave actionable notes. Your outcomes and notes are saved together.</p><p class="meta" id="progress"></p><p class="meta" id="connection">Standalone document. Export Markdown to hand your results back to the agent.</p></header><ol id="items"></ol><div class="actions"><button id="save" hidden>Save draft</button><button id="reload" class="secondary" hidden>Reload saved answers</button><button id="export" class="secondary">Export Markdown</button></div><p id="notice" role="status" aria-live="polite"></p></main>
<script type="module">
${sdk}
const definition = ${json};
const outcomes = [['pending','Not checked'],['complete','Complete'],['broken','Broken'],['change_requested','Request change'],['skipped','Skipped']];
const answers = new Map(definition.items.map(item => [item.id,{itemId:item.id,outcome:'pending',notes:''}]));
const controls = new Map();
let dirty = false;
let busy = false;
const notice = document.querySelector('#notice');
const save = document.querySelector('#save');
const reload = document.querySelector('#reload');
const exported = document.querySelector('#export');
function show(message,error=false){notice.textContent=message;notice.dataset.error=String(error)}
function progress(){const values=[...answers.values()];document.querySelector('#progress').textContent=values.filter(a=>a.outcome==='complete').length+' / '+values.length+' complete · '+values.filter(a=>a.outcome==='broken'||a.outcome==='change_requested').length+' need attention'}
for(const item of definition.items){
 const row=document.createElement('li');const heading=document.createElement('h2');heading.textContent=item.title;row.append(heading);
 if(item.description){const p=document.createElement('p');p.className='description';p.textContent=item.description;row.append(p)}
 const select=document.createElement('select');const selectId='outcome-'+controls.size;select.id=selectId;const outcomeLabel=document.createElement('label');outcomeLabel.htmlFor=selectId;outcomeLabel.textContent='Outcome';
 for(const [value,label] of outcomes){const option=document.createElement('option');option.value=value;option.textContent=label;select.append(option)}
 const notes=document.createElement('textarea');notes.maxLength=8000;notes.id='notes-'+controls.size;const noteLabel=document.createElement('label');noteLabel.htmlFor=notes.id;noteLabel.textContent='Notes';
 const changed=()=>{answers.set(item.id,{itemId:item.id,outcome:select.value,notes:notes.value});dirty=true;progress();show('Unsaved changes')};
 select.addEventListener('change',changed);notes.addEventListener('input',changed);row.append(outcomeLabel,select,noteLabel,notes);controls.set(item.id,{select,notes});document.querySelector('#items').append(row);
}
function lock(value){for(const control of controls.values()){control.select.disabled=value;control.notes.disabled=value}save.disabled=value;reload.disabled=busy}
const client=createSatelliteDocumentClient({
 onConnection(){save.hidden=false;reload.hidden=false;exported.hidden=true;document.querySelector('#connection').textContent='Connected to SatelliteT3. Save here; use Submit to agent or Export Markdown in the document toolbar.'},
 onState(state){
  for(const item of definition.items){const value=state.answers.find(a=>a.itemId===item.id)||{itemId:item.id,outcome:'pending',notes:''};answers.set(item.id,value);const control=controls.get(item.id);control.select.value=value.outcome;control.notes.value=value.notes}
  dirty=false;progress();lock(state.readOnly||busy);show(state.readOnly?'Retained review · read-only':'Saved answer revision '+state.answerRevision);
 }
});
save.addEventListener('click',async()=>{if(busy)return;busy=true;lock(true);show('Saving…');try{await client.saveDraft([...answers.values()])}catch(error){show(error.message,true)}finally{busy=false;lock(client.readOnly)}});
reload.addEventListener('click',async()=>{if(dirty&&!confirm('Replace these unsaved answers with the saved version?'))return;busy=true;lock(true);try{await client.load()}catch(error){show(error.message,true)}finally{busy=false;lock(client.readOnly)}});
exported.addEventListener('click',()=>{const lines=['# '+definition.title,''];for(const item of definition.items){const answer=answers.get(item.id);lines.push('- ['+(answer.outcome==='complete'?'x':' ')+'] '+item.title+' — '+answer.outcome.replaceAll('_',' '));if(answer.notes)lines.push('  '+answer.notes.replaceAll('\\n','\\n  '));lines.push('')}const url=URL.createObjectURL(new Blob([lines.join('\\n')],{type:'text/markdown;charset=utf-8'}));const link=document.createElement('a');link.href=url;link.download='review-results.md';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000)});
window.addEventListener('beforeunload',event=>{if(dirty){event.preventDefault();event.returnValue=''}});
progress();
</script></body></html>`;
  await NodeFSP.mkdir(NodePath.dirname(NodePath.resolve(outputPath)), { recursive: true });
  await NodeFSP.writeFile(outputPath, html, { encoding: "utf8", flag: "wx" });
  console.log(NodePath.resolve(outputPath));
}
