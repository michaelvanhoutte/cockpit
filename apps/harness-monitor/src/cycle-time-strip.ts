/**
 * The strip a cycle time table row opens, drawn in the browser from the figures
 * the row already carries (`data-figures`: one number per outline slot, in
 * OUTLINE_SLOTS order, milliseconds in base 36, on the table's own measure), so
 * opening is no request. The
 * page needs no script otherwise: the chevrons are the script's own, so
 * without one the table is as it was and no strip opens.
 */

/** The two pure functions of the script: a duration as `hm` reads it, and `layOut` (cycle-time-report.ts) over slots `[label, part, other, colour]`. A unit test holds both to the server's. */
export const STRIP_LAYOUT_SOURCE = `
function hm(ms){
  if(ms<59500)return ms<=0?'0m':Math.round(ms/1000)+'s';
  var m=Math.round(ms/60000);
  if(m<60)return m+'m';
  return Math.floor(m/60)+'h '+String(m%60).padStart(2,'0')+'m';
}
function layOut(slots,figures){
  var total=0,i;
  for(i=0;i<slots.length;i++)if(!slots[i][1])total+=figures[i];
  var scale=function(ms){return total?ms/total:0};
  var rows=[],at=0,inside=0,phaseMs=0,stretch=null;
  for(i=0;i<slots.length;i++){
    var part=slots[i][1],ms=figures[i];
    if(!part){
      stretch=ms>0?{left:scale(at),width:scale(ms)}:null;
      if(!stretch)continue;
      phaseMs=ms;inside=at;
      rows.push({slot:i,ms:ms,share:scale(ms),left:stretch.left,width:stretch.width,stretch:null});
      at+=ms;
    }else if(stretch&&ms>0){
      rows.push({slot:i,ms:ms,share:phaseMs?ms/phaseMs:0,left:scale(inside),width:scale(ms),stretch:stretch});
      inside+=ms;
    }
  }
  return{total:total,rows:rows};
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
    var figures=row.getAttribute('data-figures').split(',').map(function(x){return parseInt(x,36)||0});
    while(figures.length<slots.length)figures.push(0);
    var ul=el('ul','outline');
    ul.setAttribute('aria-label','Phases of start to merge for this row, with local checks and CI rounds opened into their parts');
    layOut(slots,figures).rows.forEach(function(r){
      var s=slots[r.slot];
      var li=el('li','o-row '+(s[1]?'o-pt':'o-ph'));
      li.appendChild(el('span','nm',s[0]));
      var track=el('div','tr');
      if(r.stretch){
        var band=el('div','band');
        band.style.left=pct(r.stretch.left);band.style.width=pct(r.stretch.width);
        track.appendChild(band);
      }
      var bar=el('div','b');
      bar.style.left=pct(r.left);bar.style.width=pct(r.width);bar.style.background=s[3];
      bar.title=s[0]+' '+hm(r.ms);
      track.appendChild(bar);
      li.appendChild(track);
      li.appendChild(el('span','am',hm(r.ms)));
      li.appendChild(el('span','sh',Math.round(r.share*100)+'%'));
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
  [].forEach.call(body.querySelectorAll('tr[data-figures]'),function(row){
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
