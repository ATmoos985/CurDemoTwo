import {getInitialScenarios} from '../plugins/presets/scenarios.js';
import {rectangle, polygon} from './nesting-scene.js';

export function garmentExample(id) {
    // shortcut: 用折线近似服装曲边；接入生产纸样时需真实曲线、缝份与丝缕校验。
    const samples = {
        GARMENT_SHIRT: {height:1600, parts:[
            ['上衣前片', 1, [[0,640],[20,380],[0,220],[45,205],[70,170],[85,120],[90,55],[180,0],[195,35],[220,65],[250,75],[280,65],[305,35],[320,0],[410,55],[415,120],[430,170],[455,205],[500,220],[480,380],[500,640]]],
            ['上衣后片', 1, [[0,650],[20,380],[0,220],[45,205],[70,170],[85,120],[90,55],[180,0],[210,20],[250,28],[290,20],[320,0],[410,55],[415,120],[430,170],[455,205],[500,220],[480,380],[500,650]]],
            ['袖片', 2, [[0,150],[25,100],[65,55],[110,18],[160,0],[210,18],[255,55],[295,100],[320,150],[280,500],[40,500]]]
        ]},
        GARMENT_PANTS: {height:2200, parts:[
            ['前裤片', 2, [[70,0],[350,15],[380,150],[390,250],[420,320],[340,360],[305,600],[270,1050],[70,1050],[45,650],[0,310],[25,120]]],
            ['后裤片', 2, [[100,0],[390,20],[420,170],[430,270],[480,340],[370,390],[330,650],[290,1080],[70,1080],[45,650],[0,320],[30,140]]],
            ['裤袋', 2, [[0,0],[170,0],[185,130],[160,195],[110,230],[45,215],[10,160]]]
        ]},
        GARMENT_SKIRT: {height:1400, parts:[
            ['半裙裁片', 4, [[100,0],[170,15],[240,20],[310,15],[380,0],[480,900],[400,930],[320,945],[240,950],[160,945],[80,930],[0,900]]],
            ['半裙贴袋', 2, [[0,0],[160,0],[160,160],[130,195],[80,210],[30,195],[0,160]]]
        ]}
    };
    samples.GARMENT_FULL = {height:2000, parts:[
        ...samples.GARMENT_SHIRT.parts.map(([name,,points], index) => [name,[3,3,8][index],points]),
        [samples.GARMENT_SKIRT.parts[1][0],12,samples.GARMENT_SKIRT.parts[1][2]]
    ]};
    const sample = samples[id];
    if (!sample) throw new Error('服装示例不存在');
    return {schemaVersion:'1', unit:'mm', engine:'auto', timeLimitSeconds:id === 'GARMENT_FULL' ? 10 : 3,
        material:{id:`DEMO-${id}`, shape:rectangle(1500,sample.height), continuesAfterRegion:false, exclusions:[]},
        parts:sample.parts.map(([name,quantity,points], index) => ({id:index+1,name,quantity,allowRotation:false,
            shape:polygon(points.map(([x,y]) => ({x,y})))})),
        process:{mode:'CONTOUR',feedMode:'SHEET',startCorner:'left-top',firstStageOrientation:'none',trimStart:0,
            minReusableWidth:0,minReusableHeight:0,kerf:0,objective:'MAXIMIZE_PIECE_AREA'}};
}

export function scenarioExample(id) {
    const source = getInitialScenarios()[id], continuous = source.totalRollL > source.bedL;
    const width = source.rollW, height = source.bedL;
    return {schemaVersion:'1',unit:'mm',engine:'auto',timeLimitSeconds:3,
        material:{id:`DEMO-${id}`,shape:rectangle(width,height),continuesAfterRegion:continuous,
            exclusions:(source.globalDefects || []).flatMap(d => {
                const margin = d.margin || 0, x = Math.max(0,d.x-margin), y = Math.max(0,d.y-margin);
                const w = Math.min(width,d.x+d.w+margin)-x, h = Math.min(height,d.y+d.h+margin)-y;
                return w > 0 && h > 0 ? [{id:d.id,x,y,shape:rectangle(w,h),clearance:0}] : [];
            })},
        parts:source.demands.map(d => ({id:d.id,name:d.name,shape:rectangle(d.w ?? d.width,d.l ?? d.length),quantity:d.count,allowRotation:d.allowRotation ?? source.allowRotation})),
        process:{mode:source.allowLongitudinal ? 'GUILLOTINE' : 'CROSSCUT',feedMode:continuous ? 'CONTINUOUS' : 'SHEET',startCorner:source.cutOrigin,
            firstStageOrientation:source.firstStageOrientation,trimStart:source.trimStart,minReusableWidth:100,minReusableHeight:100,kerf:0,
            objective:source.allowLongitudinal ? 'MAXIMIZE_PIECE_AREA' : 'INPUT_ORDER'}};
}
