import test from 'node:test';
import assert from 'node:assert/strict';
import {polygon} from '../../../frontend/src/lib/canvas/nesting-scene.js';
import {parseDemandJSON,importedTask} from '../../../frontend/src/lib/domain/demand-import-model.js';
const shape=polygon([{x:0,y:0},{x:200,y:0},{x:0,y:200}]);

test('JSON demand import keeps actual outlines',()=>{
 const imported=importedTask(parseDemandJSON({materialModel:'布',demands:[{name:'衣片',width:200,length:200,quantity:2,allowRotation:false,shape}]}),0,'test');
 assert.deepEqual(imported.demands[0].shape,shape);
});
