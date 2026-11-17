import {markerExample} from '../../nesting/marker-demo.js';

export function garmentDemands(style) {
    return markerExample(1500, style).parts.map(({id, name, shape, quantity, allowRotation}) => ({
        id, name, width: shape.width, length: shape.height, quantity, allowRotation, shape
    }));
}
