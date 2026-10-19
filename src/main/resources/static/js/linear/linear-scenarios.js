import {defaults} from './linear-model.js';

const order = (messageText, width, quantity, length, surfaceTreatment) => ({messageText, width, quantity, length, surfaceTreatment});

/** 搭切对比页的示例需求，键与 industry-profiles 中“卷材 · 薄膜”的一维场景一一对应；名称和说明在那边维护。
 *  lengthUnit 只影响页面显示，求解器不关心单位。 */
export const LINEAR_SCENARIOS = Object.freeze({
    film: {
        lengthUnit: 'm',
        input: {...defaults, motherWidth: 4600, leftTrim: 100, rightTrim: 100, minWidth: 4200, maxWidth: 4400, step: 10, totalOverCap: 30,
            orderItems: [order('客户甲', 1250, 18, 6000, '单面处理'), order('客户乙', 1520, 14, 6000, '单面处理'),
                order('客户丙', 1630, 10, 6000, '单面处理'), order('客户丁', 1380, 12, 6000, '单面处理')]}
    },
    curtain: {
        lengthUnit: 'm',
        input: {...defaults, motherWidth: 2800, leftTrim: 20, rightTrim: 20, minWidth: 2660, maxWidth: 2760, step: 10, totalOverCap: 30,
            orderItems: [order('A 户型', 900, 20, 50, '涂层'), order('B 户型', 1200, 16, 50, '涂层'),
                order('C 户型', 1500, 12, 50, '涂层'), order('D 户型', 600, 30, 50, '涂层')]}
    },
    board: {
        lengthUnit: 'mm',
        input: {...defaults, motherWidth: 1220, leftTrim: 5, rightTrim: 5, minWidth: 1180, maxWidth: 1210, step: 5, totalOverCap: 30,
            orderItems: [order('抽屉侧条', 280, 30, 2440, '三聚氰胺'), order('隔板条', 420, 20, 2440, '三聚氰胺'),
                order('门框条', 560, 14, 2440, '三聚氰胺'), order('踢脚条', 350, 24, 2440, '三聚氰胺')]}
    }
});
