export const hubDashboard = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Active hubs</title>
<style>body{font:16px system-ui,sans-serif;background:#171717;color:#eee;margin:0}main{max-width:60rem;margin:auto;padding:2rem}h1{font-size:1.6rem}ul{list-style:none;padding:0}li{padding:1rem 0;border-bottom:1px solid #555;overflow-wrap:anywhere}a{color:#ffad66;font-weight:600}p{color:#ccc}</style></head>
<body><main><h1>Active hubs</h1><p id="status" role="status">Loading hubs…</p><ul id="hubs"></ul></main>
<script>
async function refresh(){const status=document.querySelector('#status'),list=document.querySelector('#hubs');try{const response=await fetch('/api/hubs',{cache:'no-store'});if(!response.ok)throw Error();const data=await response.json();const items=data.hubs.map(hub=>{const li=document.createElement('li'),a=document.createElement('a'),p=document.createElement('p');a.href=hub.url;a.textContent=hub.label;p.textContent=hub.summary===null?'Working-copy parent unavailable':hub.summary;li.append(a,p);return li});list.replaceChildren(...items);status.textContent=items.length?'':'No active hubs.'}catch{status.textContent='Hubs are unavailable. Retrying…';list.replaceChildren()}setTimeout(refresh,5000)}refresh();
</script></body></html>`;
