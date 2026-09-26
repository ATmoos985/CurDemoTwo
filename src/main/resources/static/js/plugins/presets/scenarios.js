/**
 * 工业案例预设数据集 (Industrial Scenarios & Specs)
 * 涵盖：窗帘整幅定高横切、偏幅纵切改宽、短料0扣料套裁、窗幔配件二维断刀、Word表1正交拆解与60米长卷全貌
 */
export const MOTHER_ROLL_SPECS = {
    "ROLL-2026-0920": { model: "TC涤棉-B2026", rollW: 2000, totalRollL: 60000, bedL: 5000 },
    "ROLL-2026-0921": { model: "纯棉斜纹-C1800", rollW: 1800, totalRollL: 50000, bedL: 5000 },
    "ROLL-2026-0922": { model: "弹力牛津-O2200", rollW: 2200, totalRollL: 80000, bedL: 5000 },
    "ROLL-DEMO-2D": { model: "窗帘样布-2D", rollW: 2000, totalRollL: 30000, bedL: 4000 }
};

export const INITIAL_SCENARIOS = {
    // -------------------------------------------------------------
    // 案例 1：窗帘整幅定高横切 (仅横切避疵 · 经典落地帘)
    // -------------------------------------------------------------
    1: {
        name: "案例1: 窗帘定高整幅横切 (仅横切避疵)",
        rollId: "ROLL-2026-0920", totalRollL: 60000, bedL: 5000, windowStartY: 0, rollW: 2000,
        trimStart: 0, cutOrigin: "right-bottom", firstStageOrientation: "horizontal",
        allowRotation: false, allowLongitudinal: false,
        globalDefects: [
            { id: 1, x: 400, y: 1400, w: 200, h: 150, margin: 20, desc: "台面 1.4m 经向破洞 (强制避让)" },
            { id: 2, x: 1100, y: 3200, w: 160, h: 100, margin: 20, desc: "台面 3.2m 纬向抽纱 (强制避让)" }
        ],
        demands: [{ id: 1, name: "落地窗帘主片", w: 2000, l: 1200, count: 2 }],
        pieces: [
            { id: 1, demandId: 1, name: "落地窗帘主片 #1", x: 0, y: 0, w: 2000, l: 1200 },
            { id: 2, demandId: 1, name: "落地窗帘主片 #2", x: 0, y: 1570, w: 2000, l: 1200 }
        ],
        remnants: [
            { id: "REM-DEF-01", status: "带疵短料料头", x: 0, y: 1200, w: 2000, l: 370, area: 0.74, hasDefect: true },
            { id: "REM-01", status: "台面可用料头", x: 0, y: 2770, w: 2000, l: 2230, area: 4.46, hasDefect: false }
        ],
        cuts: [
            { step: 1, type: "横切", pos: 1200, start: 0, end: 2000, desc: "第1阶段横切：在展开1200mm处横切断刀，切出第1件落地窗帘成品(2m×1.2m)" },
            { step: 2, type: "横切", pos: 1570, start: 0, end: 2000, desc: "第1阶段横切：在展开1570mm处横切断刀，隔离0.37m带疵短料(含经向破洞)" },
            { step: 3, type: "横切", pos: 2770, start: 0, end: 2000, desc: "第1阶段横切：在展开2770mm处横切断刀，切出第2件落地窗帘成品，余下2.23m规整料头" }
        ],
        deductLen: 2770, pieceArea: 4.80, remArea: 5.20, wasteArea: 0.00, totalArea: 10.00,
        engine: "仅横切顺序排料"
    },

    // -------------------------------------------------------------
    // 案例 2：偏幅单开帘纵切改宽 (分幅避障 · 纵向切透)
    // -------------------------------------------------------------
    2: {
        name: "案例2: 偏幅单开帘纵切改宽 (分幅避障)",
        rollId: "ROLL-DEMO-2D", totalRollL: 30000, bedL: 4000, windowStartY: 0, rollW: 2000,
        trimStart: 0, cutOrigin: "right-bottom", firstStageOrientation: "vertical",
        allowRotation: false, allowLongitudinal: true,
        globalDefects: [
            { id: 1, x: 200, y: 1500, w: 150, h: 600, margin: 50, desc: "左侧0~500mm条带织造破洞与污损" }
        ],
        demands: [{ id: 1, name: "单开偏幅窗帘", w: 1500, l: 4000, count: 1 }],
        pieces: [
            { id: 1, demandId: 1, name: "单开偏幅窗帘", x: 500, y: 0, w: 1500, l: 4000 }
        ],
        remnants: [
            { id: "REM-DEF-01", status: "左侧带疵料头", x: 0, y: 0, w: 500, l: 4000, area: 2.00, hasDefect: true }
        ],
        cuts: [
            { step: 1, type: "纵切", pos: 500, start: 0, end: 4000, desc: "在宽度500mm处一刀纵切到底，靠右下角完好产出1.5m×4m单开帘成品，左侧0.5m×4m带疵料头建档入库" }
        ],
        deductLen: 4000, pieceArea: 6.00, remArea: 2.00, wasteArea: 0.00, totalArea: 8.00,
        engine: "纵切改宽排料引擎"
    },

    // -------------------------------------------------------------
    // 案例 3：在库短料料头优先复用 (0母卷扣料 · 飘窗短帘)
    // -------------------------------------------------------------
    3: {
        name: "案例3: 在库短料料头套裁 (0母卷扣料)",
        rollId: "ROLL-2026-0920", totalRollL: 1600, bedL: 1600, windowStartY: 0, rollW: 2000,
        trimStart: 0, cutOrigin: "right-bottom", firstStageOrientation: "horizontal",
        allowRotation: false, allowLongitudinal: false,
        globalDefects: [],
        demands: [{ id: 1, name: "飘窗短帘成品", w: 2000, l: 1000, count: 1 }],
        pieces: [
            { id: 1, demandId: 1, name: "飘窗短帘成品 (领用料头)", x: 0, y: 600, w: 2000, l: 1000 }
        ],
        remnants: [
            { id: "REM-202609-001-SUB01", status: "派生可用子料头", x: 0, y: 0, w: 2000, l: 600, area: 1.20, hasDefect: false }
        ],
        cuts: [
            { step: 1, type: "横切", pos: 600, start: 0, end: 2000, desc: "在料头展开600mm处横切断刀，切出1m短帘成品，余下0.6m派生子料头入库" }
        ],
        deductLen: 0, pieceArea: 2.00, remArea: 1.20, wasteArea: 0.00, totalArea: 3.20,
        engine: "料头精益复用调度器 (母卷0消耗)"
    },

    // -------------------------------------------------------------
    // 案例 4：窗幔帘头与配件二维套裁 (二维断刀 · 多规格高利用率)
    // -------------------------------------------------------------
    4: {
        name: "案例4: 窗幔帘头辅件套裁 (二维断刀)",
        rollId: "ROLL-2026-0920", totalRollL: 60000, bedL: 4500, windowStartY: 0, rollW: 2000,
        trimStart: 0, cutOrigin: "right-bottom", firstStageOrientation: "horizontal",
        allowRotation: false, allowLongitudinal: true,
        globalDefects: [
            { id: 1, x: 500, y: 1400, w: 150, h: 150, margin: 30, desc: "色斑瑕疵 (强制避让)" }
        ],
        demands: [
            { id: 1, name: "窗帘大幔", w: 800, l: 1200, count: 2 },
            { id: 2, name: "窗帘小幔", w: 600, l: 1000, count: 2 },
            { id: 3, name: "侧饰绑带", w: 400, l: 1500, count: 1 }
        ],
        pieces: [
            { id: 1, demandId: 1, name: "窗帘大幔 #1", x: 0, y: 0, w: 800, l: 1200 },
            { id: 2, demandId: 1, name: "窗帘大幔 #2", x: 800, y: 0, w: 800, l: 1200 },
            { id: 3, demandId: 3, name: "侧饰绑带", x: 1600, y: 0, w: 400, l: 1500 },
            { id: 4, demandId: 2, name: "窗帘小幔 #1", x: 0, y: 1600, w: 600, l: 1000 },
            { id: 5, demandId: 2, name: "窗帘小幔 #2", x: 600, y: 1600, w: 600, l: 1000 }
        ],
        remnants: [
            { id: "REM-DEF-01", status: "带疵料头", x: 0, y: 1200, w: 1600, l: 400, area: 0.64, hasDefect: true },
            { id: "REM-01", status: "右侧可用料头", x: 1200, y: 1600, w: 800, l: 2400, area: 1.92, hasDefect: false },
            { id: "REM-02", status: "底部可用料头", x: 0, y: 2600, w: 1200, l: 1400, area: 1.68, hasDefect: false }
        ],
        cuts: [
            { step: 1, type: "纵切", pos: 1600, start: 0, end: 4000, desc: "第1阶段纵切：一刀纵切切出右侧400mm绑带加工区" },
            { step: 2, type: "横切", pos: 1200, start: 0, end: 1600, desc: "第2阶段横切：切出大幔加工带，分离大幔与瑕疵隔离区" },
            { step: 3, type: "纵切", pos: 800, start: 0, end: 1200, desc: "第3阶段纵切：切断分离2件窗帘大幔" },
            { step: 4, type: "横切", pos: 1600, start: 0, end: 1600, desc: "第2阶段横切：隔离0.4m带疵料头，开启小幔加工区" },
            { step: 5, type: "横切", pos: 2600, start: 0, end: 1200, desc: "第2阶段横切：切断闭合2件小幔成品，余下底部1.4m可用料头" },
            { step: 6, type: "纵切", pos: 600, start: 1600, end: 2600, desc: "第3阶段纵切：分离2件窗帘小幔成品" }
        ],
        deductLen: 4000, pieceArea: 3.72, remArea: 4.24, wasteArea: 0.04, totalArea: 8.00,
        engine: "智能几何排料内核 (C++ 2D-Guillotine)"
    },

    // -------------------------------------------------------------
    // 案例 5：Word 规范经典算例 (Word 表1 正交拆解)
    // -------------------------------------------------------------
    5: {
        name: "案例5: Word 经典 L形拆解 (正交守恒)",
        rollId: "ROLL-2026-0920", totalRollL: 30000, bedL: 4000, windowStartY: 0, rollW: 2000,
        trimStart: 0, cutOrigin: "right-bottom", firstStageOrientation: "horizontal",
        allowRotation: false, allowLongitudinal: true,
        globalDefects: [],
        demands: [{ id: 1, name: "标准成品", w: 1500, l: 3000, count: 1 }],
        pieces: [
            { id: 1, demandId: 1, name: "标准成品", x: 500, y: 1000, w: 1500, l: 3000 }
        ],
        remnants: [
            { id: "REM-01", status: "左侧可用料头", x: 0, y: 0, w: 500, l: 4000, area: 2.00, hasDefect: false },
            { id: "REM-02", status: "上方末端料头", x: 500, y: 0, w: 1500, l: 1000, area: 1.50, hasDefect: false }
        ],
        cuts: [
            { step: 1, type: "纵切", pos: 500, start: 0, end: 4000, desc: "在宽度500mm处纵切到底，切出左侧料头(0.5m×4m)" },
            { step: 2, type: "横切", pos: 1000, start: 500, end: 2000, desc: "在展开1000mm处横切断刀，切出上方料头(1.5m×1m)，产出靠右下角的标准成品" }
        ],
        deductLen: 4000, pieceArea: 4.50, remArea: 3.50, wasteArea: 0.00, totalArea: 8.00,
        engine: "Word 规范精确拆解引擎"
    },

    // -------------------------------------------------------------
    // 案例 6：60米工业长卷全景排产 (连续母卷 · 多工位开卷搭切)
    // -------------------------------------------------------------
    6: {
        name: "案例6: 60m大卷多工位搭切 (工业全貌)",
        rollId: "ROLL-2026-0920", totalRollL: 60000, bedL: 5000, windowStartY: 0, rollW: 2000,
        trimStart: 0, cutOrigin: "right-bottom", firstStageOrientation: "horizontal",
        allowRotation: false, allowLongitudinal: true,
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
            { id: 1, name: "窗帘大片", w: 800, l: 1200, count: 6 },
            { id: 2, name: "窗帘侧片", w: 600, l: 1000, count: 6 }
        ],
        pieces: [
            { id: 1, demandId: 1, name: "窗帘大片", x: 400, y: 0, w: 800, l: 1200 },
            { id: 2, demandId: 1, name: "窗帘大片", x: 1200, y: 0, w: 800, l: 1200 },
            { id: 3, demandId: 1, name: "窗帘大片", x: 400, y: 1580, w: 800, l: 1200 },
            { id: 4, demandId: 1, name: "窗帘大片", x: 1200, y: 1580, w: 800, l: 1200 },
            { id: 5, demandId: 1, name: "窗帘大片", x: 400, y: 3330, w: 800, l: 1200 },
            { id: 6, demandId: 1, name: "窗帘大片", x: 1200, y: 3330, w: 800, l: 1200 }
        ],
        remnants: [
            { id: "REM-DEF-01", status: "带疵料头 (避让#1色斑)", x: 400, y: 1200, w: 1600, l: 380, area: 0.608, hasDefect: true },
            { id: "REM-DEF-02", status: "带疵料头 (避让#2抽纱)", x: 400, y: 2780, w: 1600, l: 550, area: 0.880, hasDefect: true },
            { id: "REM-SIDE-01", status: "左侧可用料头", x: 0, y: 0, w: 400, l: 4530, area: 1.812, hasDefect: false },
            { id: "REM-TAIL-01", status: "工位接断料头", x: 0, y: 4530, w: 2000, l: 470, area: 0.940, hasDefect: false }
        ],
        cuts: [
            { step: 1, type: "横切", pos: 4530, start: 0, end: 2000, desc: "第1阶段横切：截断工位有效加工区(4.53m)，切出卷尾0.47m完好料头" },
            { step: 2, type: "纵切", pos: 400, start: 0, end: 4530, desc: "第2阶段纵切：一刀切出左侧0.4m×4.53m通长可用料头" },
            { step: 3, type: "横切", pos: 1200, start: 400, end: 2000, desc: "第3阶段横切：避让#1瑕疵(色斑)，切断并闭合顶排2件大片成品" },
            { step: 4, type: "纵切", pos: 1200, start: 0, end: 1200, desc: "纵切分离顶排左/右两件成品" },
            { step: 5, type: "横切", pos: 1580, start: 400, end: 2000, desc: "第3阶段横切：隔离#1带疵料头(1.6m×0.38m)，开启中排加工区" },
            { step: 6, type: "横切", pos: 2780, start: 400, end: 2000, desc: "第3阶段横切：避让#2瑕疵(抽纱)，切断并闭合中排2件大片成品" },
            { step: 7, type: "纵切", pos: 1200, start: 1580, end: 2780, desc: "纵切分离中排左/右两件成品" },
            { step: 8, type: "横切", pos: 3330, start: 400, end: 2000, desc: "第3阶段横切：隔离#2带疵料头(1.6m×0.55m)，开启底排加工区" },
            { step: 9, type: "纵切", pos: 1200, start: 3330, end: 4530, desc: "纵切分离底排左/右两件成品" }
        ],
        deductLen: 4530, pieceArea: 5.76, remArea: 4.24, wasteArea: 0.00, totalArea: 10.00,
        engine: "智能几何排料内核 (多工位搭切)"
    }
};

/**
 * 深拷贝预设案例，避免状态被永久污染
 */
export function getInitialScenarios() {
    return JSON.parse(JSON.stringify(INITIAL_SCENARIOS));
}
