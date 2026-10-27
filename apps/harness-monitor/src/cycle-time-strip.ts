/**
 * The strip a cycle time table row opens, drawn in the browser from the figures
 * the row already carries (`data-figures`: one number per outline slot, in
 * OUTLINE_SLOTS order, milliseconds in base 36 on the table's own measure, a
 * dash for a part's time spent that is not recorded), so opening is no request.
 * On a row that is one pull request (`data-pr`) its timeline is drawn under the
 * outline from one request made when the row is first opened, and the strip's
 * E2E (F3) and Test lines open in turn what that check selected, one request each,
 * the first time.
 * The table needs no script otherwise (the (i)'s is src/explain.ts): the chevrons
 * are the script's own, so without one the table is as it was and no strip opens.
 */

/** The pure functions of the script: a duration as `hm` reads it, `layOut` (cycle-time-report.ts) over slots `[label, part, other, colour]`, the words a row carries (`words`), and which job's selection a line opens (`selectionOf`). A unit test holds all four to the server's. */
export const STRIP_LAYOUT_SOURCE = `
function hm(ms){
  if(ms<59500)return ms<=0?'0m':Math.round(ms/1000)+'s';
  var m=Math.round(ms/60000);
  if(m<60)return m+'m';
  return Math.floor(m/60)+'h '+String(m%60).padStart(2,'0')+'m';
}
function layOut(slots,figures){
  var total=0,i,phase=-1,spent={};
  for(i=0;i<slots.length;i++)if(!slots[i][1])total+=figures[i];
  var scale=function(ms){return total?ms/total:0};
  for(i=0;i<slots.length;i++){
    var f=figures[i];
    if(!slots[i][1]){phase=i;continue}
    if(f!==null&&f<=0)continue;
    spent[phase]=(f===null||spent[phase]===null)?null:(spent[phase]||0)+f;
  }
  var rows=[],at=0,stretch=null,open=-1;
  for(i=0;i<slots.length;i++){
    var part=slots[i][1],ms=figures[i];
    if(!part){
      stretch=ms>0?{left:scale(at),width:scale(ms)}:null;
      if(!stretch)continue;
      open=i;
      var all=spent[i];
      rows.push({slot:i,ms:ms,share:scale(ms),left:stretch.left,width:stretch.width,spent:all===undefined?null:{ms:all,overlap:all!==null&&all>ms},stretch:null});
      at+=ms;
    }else if(stretch&&(ms===null||ms>0)){
      var own=spent[open];
      rows.push({slot:i,ms:ms,share:(ms===null||!own)?null:ms/own,left:stretch.left,width:ms===null?0:Math.min(scale(ms),1-stretch.left),spent:null,stretch:stretch});
    }
  }
  return{total:total,rows:rows};
}
function selectionOf(label,part){
  return part&&label==='E2E (F3)'?'e2e':part&&label==='Test'?'test':null;
}
function words(part,r){
  var spent=null;
  if(r.spent)spent=r.spent.ms===null?'time spent not recorded':hm(r.spent.ms)+' spent'+(r.spent.overlap?' side by side':'');
  var amount=part?(r.ms===null?'not recorded':hm(r.ms)+' spent'):(r.spent?hm(r.ms)+' waited':hm(r.ms));
  return{spent:spent,amount:amount};
}
`;

/** Wires every row of `table.openable` that carries figures: a click on the row outside its links, or on its chevron, opens or closes the strip beneath it. */
export const STRIP_SCRIPT = `${STRIP_LAYOUT_SOURCE}
(function(){
  var table=document.querySelector('table.openable');
  var data=document.getElementById('outline-slots');
  if(!table||!data)return;
  var slots=JSON.parse(data.textContent);
  var body=table.tBodies[0];
  function el(tag,cls,text){
    var node=document.createElement(tag);
    if(cls)node.className=cls;
    if(text!==undefined)node.textContent=text;
    return node;
  }
  function pct(n){return (n*100).toFixed(2)+'%'}
  function outline(row){
    var figures=row.getAttribute('data-figures').split(',').map(function(x){return x==='-'?null:parseInt(x,36)||0});
    while(figures.length<slots.length)figures.push(0);
    var ul=el('ul','outline');
    ul.setAttribute('aria-label','Phases of start to merge for this row as time waited, with local checks and CI rounds opened into their parts as time spent');
    layOut(slots,figures).rows.forEach(function(r){
      var s=slots[r.slot];
      var w=words(s[1],r);
      var li=el('li','o-row '+(s[1]?'o-pt':'o-ph'));
      var name=el('span','nm',s[0]);
      if(w.spent!==null){name.appendChild(document.createTextNode(' '));name.appendChild(el('span','spent',w.spent))}
      li.appendChild(name);
      var track=el('div','tr');
      if(r.stretch){
        var band=el('div','band');
        band.style.left=pct(r.stretch.left);band.style.width=pct(r.stretch.width);
        track.appendChild(band);
      }
      if(r.ms!==null){
        var bar=el('div','b');
        bar.style.left=pct(r.left);bar.style.width=pct(r.width);bar.style.background=s[3];
        bar.title=s[0]+' '+w.amount;
        track.appendChild(bar);
      }
      if(r.stretch&&s[1]){
        var edge=el('div','edge');
        edge.style.left=pct(r.stretch.left+r.stretch.width);
        track.appendChild(edge);
      }
      li.appendChild(track);
      li.appendChild(el('span',r.ms===null?'am faint':'am',w.amount));
      li.appendChild(el('span','sh',r.share===null?'\\u2014':Math.round(r.share*100)+'%'));
      // A row that is one pull request: its E2E (F3) and Test lines open what that check selected on its last CI run.
      var job=selectionOf(s[0],s[1]);
      if(row.getAttribute('data-pr')&&job)opensWhatItSelected(li,name,row.getAttribute('data-pr'),job);
      ul.appendChild(li);
    });
    return ul;
  }
  /** The line becomes a button: one request when it is first opened, then the box beneath it is kept and shown or hidden. */
  function opensWhatItSelected(li,name,pr,job){
    var button=el('button','o-btn',name.textContent);
    button.type='button';
    button.setAttribute('aria-expanded','false');
    name.textContent='';
    name.appendChild(button);
    li.classList.add('o-open');
    li.addEventListener('click',function(e){
      if(e.target.closest('a'))return;
      var box=li.nextElementSibling;
      if(box&&!box.classList.contains('o-sel'))box=null;
      var opening=button.getAttribute('aria-expanded')!=='true';
      button.setAttribute('aria-expanded',String(opening));
      if(!opening){if(box)box.hidden=true;return}
      if(box&&!box.hasAttribute('data-failed')){box.hidden=false;return}
      if(box)box.remove();
      box=el('li','o-sel','Reading what it selected\\u2026');
      li.after(box);
      fetch('/selection/check?pr='+pr+'&job='+job).then(function(r){
        if(!r.ok)throw new Error(r.status);
        return r.text();
      }).then(function(html){
        box.innerHTML=html;
      },function(){
        box.textContent='Could not read what it selected. Close this line and open it again to try again.';
        box.setAttribute('data-failed','');
      });
    });
  }
  /** The timeline of the row's one pull request, as the piece the Monitor draws: one request, made when the row is opened, and again when the row is opened after one that failed. */
  function loadTimeline(box,pr){
    box.removeAttribute('data-failed');
    box.textContent='Reading the timeline\\u2026';
    fetch('/cycle-time/timeline?pr='+pr).then(function(r){
      if(!r.ok)throw new Error(r.status);
      return r.text();
    }).then(function(html){
      box.innerHTML=html;
    },function(){
      box.textContent='Could not read the timeline. Close this row and open it again to try again.';
      box.setAttribute('data-failed','');
    });
  }
  function toggle(row){
    var next=row.nextElementSibling;
    var detail=next&&next.classList.contains('detail')?next:null;
    var open=row.classList.toggle('open');
    var button=row.querySelector('.chev');
    button.setAttribute('aria-expanded',String(open));
    button.setAttribute('aria-label',button.getAttribute('aria-label').replace(/^(Open|Close)/,open?'Close':'Open'));
    button.textContent=open?'\\u25BE':'\\u25B8';
    if(!open){if(detail)detail.hidden=true;return}
    if(!detail){
      detail=el('tr','detail');
      var cell=el('td');
      cell.colSpan=row.cells.length;
      var strip=el('div','strip');
      strip.appendChild(outline(row));
      // A row that is one pull request: its timeline under the outline, which is drawn at once from the row's own figures.
      if(row.getAttribute('data-pr')){
        var box=el('div','tl tl-box');
        strip.appendChild(box);
        loadTimeline(box,row.getAttribute('data-pr'));
      }
      cell.appendChild(strip);
      detail.appendChild(cell);
      row.after(detail);
    }else{
      var shown=detail.querySelector('.tl-box');
      if(shown&&shown.hasAttribute('data-failed'))loadTimeline(shown,row.getAttribute('data-pr'));
    }
    detail.hidden=false;
  }
  body.addEventListener('click',function(e){
    var row=e.target.closest('tr[data-figures]');
    if(!row||!body.contains(row))return;
    var link=e.target.closest('a');
    if(link&&row.contains(link))return;
    var selected=window.getSelection();
    if(selected&&String(selected)!==''&&row.contains(selected.anchorNode)&&!e.target.closest('button'))return;
    toggle(row);
  });
  // The chevrons are the script's own: a page without it has no control that does nothing, and each row carries only its figures.
  var head=table.tHead&&table.tHead.rows[0];
  if(head){
    var th=el('th','open-cell');
    th.scope='col';
    th.appendChild(el('span','sr-only','Open a row'));
    head.insertBefore(th,head.firstChild);
  }
  [].forEach.call(body.rows,function(row){
    if(!row.hasAttribute('data-figures')){row.insertBefore(el('td','open-cell'),row.firstChild);return}
    var named=row.cells[0].cloneNode(true);
    var sub=named.querySelector('.sub');
    if(sub)sub.remove();
    var button=el('button','chev','\\u25B8');
    button.type='button';
    button.setAttribute('aria-expanded','false');
    button.setAttribute('aria-label','Open '+named.textContent.replace(/\\s+/g,' ').trim());
    var cell=el('td','open-cell');
    cell.appendChild(button);
    row.insertBefore(cell,row.firstChild);
  });
})();
`;
