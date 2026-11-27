/**
 * 工业窗帘案例预设数据集 (Curtain Manufacturing Scenarios & Specs)
 */

import { MOTHER_ROLL_SPECS, CURTAIN_ORDER_TEMPLATES } from './scenarios/specsAndTemplates.js';
import { SCENARIOS_GROUP_A } from './scenarios/scenariosGroupA.js';
import { SCENARIOS_GROUP_B } from './scenarios/scenariosGroupB.js';
import { SCENARIOS_GROUP_C } from './scenarios/scenariosGroupC.js';
import { SCENARIOS_GROUP_D } from './scenarios/scenariosGroupD.js';

export { MOTHER_ROLL_SPECS, CURTAIN_ORDER_TEMPLATES };

export const INITIAL_SCENARIOS = {
    ...SCENARIOS_GROUP_A,
    ...SCENARIOS_GROUP_B,
    ...SCENARIOS_GROUP_C,
    ...SCENARIOS_GROUP_D
};

/**
 * 深拷贝预设案例，避免状态被永久污染
 */
export function getInitialScenarios() {
    return JSON.parse(JSON.stringify(INITIAL_SCENARIOS));
}
