import {markerExample} from '../../nesting/marker-demo.js';

export function garmentDemands(style, width = 1500, sizeCounts) {
    return markerExample(width, style, sizeCounts).parts.map(({id, name, shape, quantity, allowRotation}) => ({
        id, name, width: shape.width, length: shape.height, quantity, allowRotation, shape
    }));
}
