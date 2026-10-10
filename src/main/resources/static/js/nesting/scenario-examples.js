import {getInitialScenarios} from '../plugins/presets/scenarios.js';
import {rectangle} from './nesting-scene.js';

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
