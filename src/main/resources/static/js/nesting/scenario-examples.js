import {getInitialScenarios} from '../plugins/presets/scenarios.js';
import {rectangle, polygon} from '../canvas/nesting-scene.js';

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
        ]},
        GARMENT_TANK: {height:1500, parts:[
            ['背心前片',1,[[0,620],[16,360],[0,220],[32,200],[65,145],[92,35],[145,0],[162,92],[197,150],[232,165],[267,150],[302,92],[319,0],[372,35],[399,145],[432,200],[464,220],[448,360],[464,620]]],
            ['背心后片',1,[[0,625],[18,360],[0,215],[50,170],[82,95],[94,35],[145,0],[174,44],[232,64],[290,44],[319,0],[370,35],[382,95],[414,170],[464,215],[446,360],[464,625]]],
            ['领口包条',1,[[0,0],[570,0],[570,32],[0,32]]],
            ['袖窿包条',2,[[0,0],[480,0],[480,28],[0,28]]]
        ]},
        GARMENT_SHORTS: {height:1250, parts:[
            ['短裤前片',2,[[40,0],[320,16],[346,120],[355,195],[387,238],[336,257],[309,462],[12,450],[0,195]]],
            ['短裤后片',2,[[60,0],[340,24],[366,135],[386,212],[438,255],[366,280],[332,480],[18,465],[0,206]]],
            ['松紧腰头',1,[[0,0],[820,0],[820,85],[0,85]]],
            ['贴袋',2,[[0,0],[148,0],[148,143],[100,176],[48,176],[0,143]]]
        ]},
        GARMENT_APRON: {height:1600, parts:[
            ['围裙身片',1,[[0,790],[0,270],[84,250],[152,185],[185,95],[193,0],[427,0],[435,95],[468,185],[536,250],[620,270],[620,790],[595,816],[25,816]]],
            ['前贴袋',1,[[0,0],[260,0],[260,175],[235,200],[25,200],[0,175]]],
            ['挂颈带',1,[[0,0],[560,0],[560,48],[0,48]]],
            ['腰系带',2,[[0,0],[740,0],[725,55],[0,55]]]
        ]},
        GARMENT_GORED_SKIRT: {height:1550, parts:[
            ['梯形裙片',6,[[70,0],[200,0],[270,650],[0,650]]],
            ['半腰头',2,[[0,0],[390,0],[390,75],[0,75]]]
        ]},
        GARMENT_GATHERED_SKIRT: {height:1500, parts:[
            ['抽褶裙身',2,[[0,0],[700,0],[700,640],[0,640]]],
            ['半腰头',2,[[0,0],[350,0],[350,80],[0,80]]]
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
            minReusableWidth:0,minReusableHeight:0,kerf:0,objective:'MAXIMIZE_PIECE_AREA',pieceGap:0}};
}

// 同一批柜体裁片切 1220 × 2440 整板：木纹板固定纹理方向（禁止旋转），素色板允许 90° 旋转。示例经挑选以突出旋转规则的影响。
const BOARD_PARTS = [['隔板',400,396,1], ['层板',764,396,1], ['门板',800,1200,1], ['侧板',600,500,3], ['抽屉面板',720,396,1]];

export function boardExample(id) {
    if (id !== 'BOARD_GRAIN' && id !== 'BOARD_PLAIN') throw new Error('板材示例不存在');
    return {schemaVersion:'1', unit:'mm', engine:'auto', timeLimitSeconds:3,
        material:{id:`DEMO-${id}`, shape:rectangle(1220,2440), continuesAfterRegion:false, exclusions:[]},
        parts:BOARD_PARTS.map(([name,width,length,quantity], index) => ({id:index+1, name, quantity, allowRotation:id === 'BOARD_PLAIN', shape:rectangle(width,length)})),
        process:{mode:'GUILLOTINE', feedMode:'SHEET', startCorner:'left-top', firstStageOrientation:'horizontal', trimStart:0,
            minReusableWidth:100, minReusableHeight:100, kerf:0, objective:'MAXIMIZE_PIECE_AREA', pieceGap:0}};
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
            objective:source.allowLongitudinal ? 'MAXIMIZE_PIECE_AREA' : 'INPUT_ORDER',pieceGap:0}};
}

export function basicExample(mode) {
    if (mode === 'CONTOUR') return { schemaVersion: '1', unit: 'mm', engine: 'auto', timeLimitSeconds: 3,
        material: { id: 'POLYGON-1', shape: polygon([{x:0,y:0},{x:1600,y:0},{x:1600,y:900},{x:1000,y:900},{x:1000,y:1600},{x:0,y:1600}]), continuesAfterRegion: false,
            exclusions: [{ id: 1, x: 300, y: 300, shape: rectangle(120,120), clearance: 0 }] },
        parts: [{ id: 1, name: 'L 形裁片', shape: polygon([{x:0,y:0},{x:500,y:0},{x:500,y:200},{x:200,y:200},{x:200,y:500},{x:0,y:500}]), quantity: 8, allowRotation: true },
            { id: 2, name: '三角裁片', shape: polygon([{x:0,y:0},{x:400,y:0},{x:0,y:400}]), quantity: 6, allowRotation: true }],
        process: { mode, feedMode: 'SHEET', startCorner: 'left-top', firstStageOrientation: 'none', trimStart: 0,
            minReusableWidth: 0, minReusableHeight: 0, kerf: 0, objective: 'MAXIMIZE_PIECE_AREA' } };
    const crosscut = mode === 'CROSSCUT';
    return { schemaVersion: '1', unit: 'mm', engine: 'auto', timeLimitSeconds: 3,
        material: { id: 'MATERIAL-1', shape: rectangle(2000, crosscut ? 3000 : 4000), continuesAfterRegion: false,
            exclusions: crosscut ? [] : [{ id: 1, x: 200, y: 1500, shape: rectangle(150, 600), clearance: 50 }] },
        parts: [{ id: 1, name: crosscut ? '整幅裁片' : '矩形裁片', shape: rectangle(crosscut ? 2000 : 1500, crosscut ? 1200 : 3000), quantity: crosscut ? 3 : 1, allowRotation: false }],
        process: { mode, feedMode: 'SHEET', startCorner: 'right-bottom', firstStageOrientation: 'horizontal',
            trimStart: 0, minReusableWidth: 100, minReusableHeight: 100, kerf: 0,
            objective: crosscut ? 'INPUT_ORDER' : 'MAXIMIZE_PIECE_AREA' } };
}
