import {newCuttingTask} from './task-workspace.js';
import {openDemandManager} from '../layout/workbench-panels.js';

let opening = false;
export async function openNewTask() {
    if (opening) return;
    opening = true;
    try {
        if (await newCuttingTask()) {
            openDemandManager();
            document.getElementById('task-name').select();
        }
    } finally { opening = false; }
}
