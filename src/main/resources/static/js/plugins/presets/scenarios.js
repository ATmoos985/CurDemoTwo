/**
 * 工业案例预设数据集 (Industrial Scenarios & Specs)
 */
export const MOTHER_ROLL_SPECS = {
    "ROLL-2026-0920": { model: "TC涤棉-B2026", rollW: 2000, totalRollL: 60000, bedL: 5000 },
    "ROLL-2026-0921": { model: "纯棉斜纹-C1800", rollW: 1800, totalRollL: 50000, bedL: 5000 },
    "ROLL-2026-0922": { model: "弹力牛津-O2200", rollW: 2200, totalRollL: 80000, bedL: 5000 }
};

export const INITIAL_SCENARIOS = {
    1: {
        name: "场景一：Word 表1 (L形余料正交拆解与母卷直接裁切)",
        totalRollL: 30000, bedL: 4000, windowStartY: 0, rollW: 2000,
        trimStart: 0, cutOrigin: "right-bottom", firstStageOrientation: "horizontal", allowRotation: false,
        allowLongitudinal: true,
        globalDefects: [
            { id: 1, x: 400, y: 7500, w: 120, h: 200, margin: 30, desc: "未展开 7.5m 处粗纱疵" },
            { id: 2, x: 1200, y: 14500, w: 150, h: 100, margin: 30, desc: "未展开 14.5m 处跳丝疵" },
            { id: 3, x: 800, y: 23000, w: 200, h: 180, margin: 40, desc: "未展开 23.0m 处破损破洞" }
        ],
        demands: [{ id: 1, name: "标准成品", w: 1500, l: 3000, count: 1 }],
        pieces: [{ id: 1, demandId: 1, name: "标准成品", x: 500, y: 1000, w: 1500, l: 3000 }],
        remnants: [
            { id: "REM-01", status: "左侧可用料头", x: 0, y: 0, w: 500, l: 4000, area: 2.0, hasDefect: false },
            { id: "REM-02", status: "上方末端料头", x: 500, y: 0, w: 1500, l: 1000, area: 1.5, hasDefect: false }
        ],
        cuts: [
            { step: 1, type: "纵切", pos: 500, start: 0, end: 4000, desc: "在宽度500mm处纵切到底，切出左侧料头(0.5m×4m)" },
            { step: 2, type: "横切", pos: 1000, start: 500, end: 2000, desc: "在展开1000mm处横切断刀，切出上方料头(1.5m×1m)，产出靠右下角的标准成品" }
        ],
        deductLen: 4000, pieceArea: 4.5, remArea: 3.5, wasteArea: 0.0, totalArea: 8.0,
        engine: "Word 规范精确拆解引擎"
    },
    2: {
        name: "场景一(三)：左侧0.5m带疵改宽纵切出成品",
        totalRollL: 30000, bedL: 4000, windowStartY: 0, rollW: 2000,
        trimStart: 0, cutOrigin: "right-bottom", firstStageOrientation: "vertical", allowRotation: false,
        allowLongitudinal: true,
        globalDefects: [
            { id: 1, x: 200, y: 1500, w: 150, h: 600, margin: 50, desc: "台面左侧0.5m带疵(改宽纵切)" },
            { id: 2, x: 900, y: 11000, w: 100, h: 150, margin: 30, desc: "未展开 11.0m 处污渍" },
            { id: 3, x: 500, y: 22000, w: 180, h: 180, margin: 30, desc: "未展开 22.0m 处稀密路" }
        ],
        demands: [{ id: 1, name: "改宽成品", w: 1500, l: 4000, count: 1 }],
        pieces: [{ id: 1, demandId: 1, name: "改宽成品", x: 500, y: 0, w: 1500, l: 4000 }],
        remnants: [
            { id: "REM-DEF-01", status: "左侧带疵料头", x: 0, y: 0, w: 500, l: 4000, area: 2.0, hasDefect: true }
        ],
        cuts: [
            { step: 1, type: "纵切", pos: 500, start: 0, end: 4000, desc: "在宽度500mm处一刀纵切到底，靠右下角完好产出1.5m×4m成品，保留左侧带疵料头" }
        ],
        deductLen: 4000, pieceArea: 6.0, remArea: 2.0, wasteArea: 0.0, totalArea: 8.0,
        engine: "带疵改宽排料引擎"
    },
    3: {
        name: "场景一(二)：1.6m短料生成与新订单优先领用 (0扣料)",
        totalRollL: 1600, bedL: 1600, windowStartY: 0, rollW: 2000,
        trimStart: 0, cutOrigin: "right-bottom", firstStageOrientation: "horizontal", allowRotation: false,
        allowLongitudinal: true,
        globalDefects: [],
        demands: [{ id: 1, name: "新订单成品", w: 2000, l: 1000, count: 1 }],
        pieces: [{ id: 1, demandId: 1, name: "新订单成品 (领用料头)", x: 0, y: 600, w: 2000, l: 1000 }],
        remnants: [
            { id: "REM-SHORT-SUB", status: "上方可用子料头", x: 0, y: 0, w: 2000, l: 600, area: 1.2, hasDefect: false }
        ],
        cuts: [
            { step: 1, type: "横切", pos: 600, start: 0, end: 2000, desc: "从原入库料头截取靠底部的1m成品，余下0.6m重新登记入库" }
        ],
        deductLen: 0, pieceArea: 2.0, remArea: 1.2, wasteArea: 0.0, totalArea: 3.2,
        engine: "料头优先匹配调度器 (母卷0消耗)"
    },
    4: {
        name: "场景二：60米母卷大段连续排料与全局疵点雷达 (工业全貌)",
        totalRollL: 60000, bedL: 5000, windowStartY: 0, rollW: 2000,
        trimStart: 0, cutOrigin: "right-bottom", firstStageOrientation: "horizontal", allowRotation: false,
        allowLongitudinal: true,
        globalDefects: [
            { id: 1, x: 500, y: 1400, w: 150, h: 150, margin: 30, desc: "台面第1疵点 (色斑)" },
            { id: 2, x: 1300, y: 3200, w: 200, h: 100, margin: 30, desc: "台面第2疵点 (抽纱)" },
            { id: 3, x: 600, y: 8400, w: 180, h: 120, margin: 30, desc: "进料第3疵点 (未展开 8.4m)" },
            { id: 4, x: 1400, y: 14200, w: 220, h: 150, margin: 40, desc: "进料第4疵点 (未展开 14.2m 破洞)" },
            { id: 5, x: 400, y: 22000, w: 150, h: 300, margin: 30, desc: "进料第5疵点 (未展开 22.0m 经向条痕)" },
            { id: 6, x: 1100, y: 31500, w: 160, h: 160, margin: 30, desc: "进料第6疵点 (未展开 31.5m 污渍)" },
            { id: 7, x: 800, y: 42000, w: 200, h: 200, margin: 40, desc: "进料第7疵点 (未展开 42.0m 稀密路)" },
            { id: 8, x: 300, y: 53800, w: 120, h: 180, margin: 30, desc: "进料第8疵点 (未展开 53.8m 飞纱)" }
        ],
        demands: [
            { id: 1, name: "西装前身-大片", w: 800, l: 1200, count: 12 },
            { id: 2, name: "西装后身-通背", w: 850, l: 1300, count: 10 },
            { id: 3, name: "西裤前身-主片", w: 700, l: 1100, count: 16 },
            { id: 4, name: "西裤后身-主片", w: 750, l: 1150, count: 16 },
            { id: 5, name: "上衣大袖-外片", w: 600, l: 1000, count: 20 },
            { id: 6, name: "上衣小袖-内片", w: 450, l: 600, count: 20 },
            { id: 7, name: "西服驳头-挂面", w: 350, l: 850, count: 18 },
            { id: 8, name: "衬衫领衬-硬片", w: 250, l: 480, count: 24 },
            { id: 9, name: "斜纹口袋布", w: 400, l: 400, count: 32 },
            { id: 10, name: "裤腰衬条-横裁", w: 200, l: 900, count: 20 }
        ],
        cutIntervals: [{ start: 0, end: 5000 }],
        pieces: [
            { id: 1, demandId: 1, name: "西装前身-大片", x: 400, y: 0, w: 800, l: 1200 },
            { id: 2, demandId: 1, name: "西装前身-大片", x: 1200, y: 0, w: 800, l: 1200 },
            { id: 3, demandId: 1, name: "西装前身-大片", x: 400, y: 1580, w: 800, l: 1200 },
            { id: 4, demandId: 1, name: "西装前身-大片", x: 1200, y: 1580, w: 800, l: 1200 },
            { id: 5, demandId: 1, name: "西装前身-大片", x: 400, y: 3330, w: 800, l: 1200 },
            { id: 6, demandId: 1, name: "西装前身-大片", x: 1200, y: 3330, w: 800, l: 1200 }
        ],
        remnants: [
            { id: "REM-DEF-01", status: "带疵料头 (避让#1色斑)", x: 400, y: 1200, w: 1600, l: 380, area: 0.608, hasDefect: true },
            { id: "REM-DEF-02", status: "带疵料头 (避让#2抽纱)", x: 400, y: 2780, w: 1600, l: 550, area: 0.880, hasDefect: true },
            { id: "REM-SIDE-01", status: "左侧可用料头", x: 0, y: 0, w: 400, l: 4530, area: 1.812, hasDefect: false },
            { id: "REM-TAIL-01", status: "卷尾修齐料头", x: 0, y: 4530, w: 2000, l: 470, area: 0.940, hasDefect: false }
        ],
        cuts: [
            { step: 1, type: "横切", pos: 4530, start: 0, end: 2000, desc: "第1阶段横切：截断工位有效加工区(4.53m)，切出卷尾0.47m完好料头" },
            { step: 2, type: "纵切", pos: 400, start: 0, end: 4530, desc: "第2阶段纵切：一刀切出左侧0.4m×4.53m通长可用料头" },
            { step: 3, type: "横切", pos: 1200, start: 400, end: 2000, desc: "第3阶段横切：避让#1瑕疵(色斑)，切断并闭合顶排2件大片成品" },
            { step: 4, type: "纵切", pos: 1200, start: 0, end: 1200, desc: "纵切分离顶排左/右两件西装大片" },
            { step: 5, type: "横切", pos: 1580, start: 400, end: 2000, desc: "第3阶段横切：隔离#1带疵料头(1.6m×0.38m)，开启中排加工区" },
            { step: 6, type: "横切", pos: 2780, start: 400, end: 2000, desc: "第3阶段横切：避让#2瑕疵(抽纱)，切断并闭合中排2件大片成品" },
            { step: 7, type: "纵切", pos: 1200, start: 1580, end: 2780, desc: "纵切分离中排左/右两件西装大片" },
            { step: 8, type: "横切", pos: 3330, start: 400, end: 2000, desc: "第3阶段横切：隔离#2带疵料头(1.6m×0.55m)，开启底排加工区" },
            { step: 9, type: "纵切", pos: 1200, start: 3330, end: 4530, desc: "纵切分离底排左/右两件西装大片" }
        ],
        deductLen: 4530, pieceArea: 5.76, remArea: 4.24, wasteArea: 0.00, totalArea: 10.00,
        engine: "PackingSolver (C++ 2D-Guillotine & HiGHS)"
    }
};

/**
 * 深拷贝预设案例，避免状态被永久污染
 */
export function getInitialScenarios() {
    return JSON.parse(JSON.stringify(INITIAL_SCENARIOS));
}
