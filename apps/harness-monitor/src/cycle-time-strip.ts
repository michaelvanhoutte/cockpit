/**
 * The strip a cycle time table row opens, drawn in the browser from the figures
 * the row already carries (`data-figures`: one number per outline slot, in
 * OUTLINE_SLOTS order, milliseconds in base 36 on the table's own measure, a
 * dash for a part's time spent that is not recorded), so opening is no request.
 * The page needs no script otherwise: the chevrons are the script's own, so
 * without one the table is as it was and no strip opens.
 */

/** The pure functions of the script: a duration as `hm` reads it, `layOut` (cycle-time-report.ts) over slots `[label, part, other, colour]`, and the words a row carries (`words`). A unit test holds all three to the server's. */
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
      ul.appendChild(li);
    });
    return ul;
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
      cell.appendChild(strip);
      detail.appendChild(cell);
      row.after(detail);
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
