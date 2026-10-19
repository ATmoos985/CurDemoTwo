import {INDUSTRIES} from '../industry/industry-profiles.js';
import {markerExample} from '../nesting/marker-demo.js';
import {shapeVertices} from '../nesting/nesting-scene.js';
import './cutting-showcase.js';

const groups = document.getElementById('demo-groups');
for (const industry of INDUSTRIES) {
    const group = document.createElement('div'); group.className='demo-group';
    const heading=document.createElement('h3');heading.textContent=industry.name;group.append(heading);
    const scenarios=[...industry.scenarios];
    if(industry.id==='garment')scenarios.unshift({key:'MARKER',name:'齐套唛架 · 固定布宽缩短长度'});
    for(const scene of scenarios){
        const link=document.createElement('a');link.textContent=scene.name;
        const type=scene.key==='MARKER'?'marker':industry.dimension==='一维'?'linear':'sheet';
        link.href=`/demos.html?scenario=${encodeURIComponent(scene.key)}#${type}`;group.append(link);
    }
    groups.append(group);
}
const parts=markerExample().parts.slice(0,6), ns='http://www.w3.org/2000/svg';
const placements=[[0,45,52,.34],[1,220,52,.34],[2,400,55,.26],[2,490,55,.26],[3,400,215,.25],[4,510,225,.25],[4,535,225,.25],[5,400,265,.26],[5,452,265,.26]];
const svg=document.getElementById('garment-preview');
svg.innerHTML='<rect x="35" y="40" width="550" height="300" fill="#f5f8f1" stroke="#90a896"/><path d="M35 24H585M35 18V30M585 18V30" stroke="#6c8979"/><text x="310" y="17" text-anchor="middle" fill="#416450" font-size="12">门幅固定 · 所有衣片齐套排入</text>';
for(const [index,x,y,scale] of placements){
    const part=parts[index],path=document.createElementNS(ns,'polygon');
    path.setAttribute('points',shapeVertices(part.shape).map(p=>`${x+p.x*scale},${y+p.y*scale}`).join(' '));
    path.setAttribute('fill',index<2?'#a8cbb9':index===2?'#c5d8b3':'#dfcfaa');path.setAttribute('stroke','#597c69');svg.append(path);
    const arrow=document.createElementNS(ns,'path');const ax=x+part.shape.width*scale/2,ay=y+part.shape.height*scale/2;
    arrow.setAttribute('d',`M${ax} ${ay+10}V${ay-10}m-3 4 3-4 3 4`);arrow.setAttribute('stroke','#476956');arrow.setAttribute('fill','none');svg.append(arrow);
}
