/**
 * 工业窗帘案例预设数据集 (Curtain Manufacturing Scenarios & Specs)
 * 涵盖：
 * 1. 窗帘定高整幅横切 (经典工程套排 · 多房间整幅连续横切)
 * 2. 偏幅单开帘与边角套裁 (边角料吃净 · 落地帘+边饰长绑带+同色抱枕)
 * 3. 在库短料料头套裁 (0母卷扣料 · 飘窗短帘+抱枕+挂带精益下料)
 * 4. 窗幔帘头辅件套裁 (欧式豪华水波幔+垂花平幔+造型绑带+抱枕直刀套裁)
 * 5. Word 经典 L形拆解 (工程主帘与面积严密守恒基准算例)
 * 6. 60m大卷多工位搭切 (10件套客房全貌 · 连续开卷搭切与全卷雷达)
 */

export const MOTHER_ROLL_SPECS = {
    "ROLL-2026-0920": { model: "TC涤棉-B2026", rollW: 2000, totalRollL: 60000, bedL: 5000 },
    "ROLL-2026-0921": { model: "纯棉斜纹-C1800", rollW: 1800, totalRollL: 50000, bedL: 5000 },
    "ROLL-2026-0922": { model: "弹力牛津-O2200", rollW: 2200, totalRollL: 80000, bedL: 5000 },
    "ROLL-DEMO-2D": { model: "窗帘样布-2D", rollW: 2000, totalRollL: 30000, bedL: 4000 }
};

export const CURTAIN_ORDER_TEMPLATES = {
    "whole_house": {
        name: "全屋整套窗帘工程批量单 (32件套 · 支持跨工位接续搭切)",
        desc: "涵盖多房间落地主帘、飘窗双开帘、造型绑带及同款沙发抱枕套，充足配额供连续搭切",
        demands: [
            { name: "客厅2.6m落地主帘 (左片)", width: 800, length: 1200, count: 6 },
            { name: "主卧双开飘窗帘 (右片)", width: 600, length: 1000, count: 8 },
            { name: "窗帘造型定型绑带", width: 200, length: 800, count: 12 },
            { name: "同款面料沙发抱枕套", width: 450, length: 450, count: 6 }
        ]
    },
    "hotel_batch": {
        name: "星级酒店标准客房工程批量单 (50件套 · 支持多工位连续搭切)",
        desc: "大门幅连续工程排布，包含标房落地主帘、套房侧帘拼片及客房定型绑带，支持全卷推进",
        demands: [
            { name: "标房落地主帘", width: 800, length: 1200, count: 16 },
            { name: "套房侧帘拼片", width: 600, length: 1000, count: 16 },
            { name: "客房装饰绑带", width: 200, length: 800, count: 18 }
        ]
    },
    "edge_nesting": {
        name: "偏幅落地大帘+边角辅件连续单 (24件套 · 支持多工位搭切)",
        desc: "单开大帘改宽，边料空间见缝插针套裁长绑带与抱枕，充足件数支持多工位连续下料",
        demands: [
            { name: "单开偏幅落地大帘", width: 1400, length: 3800, count: 4 },
            { name: "窗帘造型边饰绑带", width: 150, length: 800, count: 12 },
            { name: "配套同色抱枕套片", width: 450, length: 450, count: 8 }
        ]
    },
    "valance_suite": {
        name: "豪华窗幔与全屋辅配件工程单 (40件套 · 支持连续搭切)",
        desc: "大水波造型幔、小垂花平幔、边饰挂带与抱枕套高密度直刀套裁，满足连续多机台工位",
        demands: [
            { name: "客厅大水波造型幔", width: 800, length: 1200, count: 8 },
            { name: "次卧小垂花平幔", width: 600, length: 1000, count: 8 },
            { name: "窗帘立体造型绑带", width: 200, length: 800, count: 16 },
            { name: "同款沙发布抱枕套", width: 450, length: 450, count: 8 }
        ]
    },
    "remnant_reuse": {
        name: "在库短料料头 0 扣料精益复用单 (5件套)",
        desc: "领用 2000×1600 短料，套裁次卧飘窗帘、挂带与抱枕，母卷0消耗",
        demands: [
            { name: "次卧飘窗短帘主片", width: 1200, length: 1000, count: 1 },
            { name: "同款沙发抱枕套片", width: 450, length: 450, count: 2 },
            { name: "窗帘立体定型绑带", width: 150, length: 650, count: 2 }
        ]
    }
};

export const INITIAL_SCENARIOS = {
    "1": {
        "name": "案例1: 窗帘定高整幅横切 (连续工程套排 · 30件大单)",
        "rollId": "ROLL-2026-0920",
        "totalRollL": 60000,
        "bedL": 5000,
        "windowStartY": 0,
        "rollW": 2000,
        "trimStart": 0,
        "cutOrigin": "right-bottom",
        "firstStageOrientation": "horizontal",
        "allowRotation": false,
        "allowLongitudinal": false,
        "globalDefects": [
            {
                "id": 1,
                "x": 400,
                "y": 1400,
                "w": 200,
                "h": 150,
                "margin": 20,
                "desc": "台面 1.4m 经向破洞 (强制避让)"
            },
            {
                "id": 2,
                "x": 1100,
                "y": 3200,
                "w": 160,
                "h": 100,
                "margin": 20,
                "desc": "台面 3.2m 纬向抽纱 (强制避让)"
            }
        ],
        "demands": [
            {
                "id": 1,
                "name": "客厅2.6m落地大主帘 (定高)",
                "w": 2000,
                "l": 1200,
                "count": 8
            },
            {
                "id": 2,
                "name": "主卧双开主帘左片 (定高)",
                "w": 2000,
                "l": 1200,
                "count": 8
            },
            {
                "id": 3,
                "name": "主卧双开主帘右片 (定高)",
                "w": 2000,
                "l": 1200,
                "count": 8
            },
            {
                "id": 4,
                "name": "次卧单开飘窗帘 (定高)",
                "w": 2000,
                "l": 1000,
                "count": 6
            }
        ],
        "pieces": [
            {
                "demandId": 1,
                "id": 1,
                "l": 1200,
                "name": "客厅2.6m落地大主帘 (定高)",
                "rotated": false,
                "w": 2000,
                "x": 0,
                "y": 0
            },
            {
                "demandId": 2,
                "id": 2,
                "l": 1200,
                "name": "主卧双开主帘左片 (定高)",
                "rotated": false,
                "w": 2000,
                "x": 0,
                "y": 1570
            },
            {
                "demandId": 3,
                "id": 3,
                "l": 1200,
                "name": "主卧双开主帘右片 (定高)",
                "rotated": false,
                "w": 2000,
                "x": 0,
                "y": 3320
            }
        ],
        "remnants": [
            {
                "id": "REM-CROSS-1",
                "status": "带疵料头",
                "x": 0,
                "y": 1200,
                "w": 2000,
                "l": 370,
                "area": 0.74,
                "hasDefect": true
            },
            {
                "id": "REM-CROSS-2",
                "status": "带疵料头",
                "x": 0,
                "y": 2770,
                "w": 2000,
                "l": 550,
                "area": 1.1,
                "hasDefect": true
            },
            {
                "id": "REM-CROSS-3",
                "status": "可用料头",
                "x": 0,
                "y": 4520,
                "w": 2000,
                "l": 480,
                "area": 0.96,
                "hasDefect": false
            }
        ],
        "cuts": [
            {
                "step": 1,
                "type": "横切",
                "pos": 1200,
                "start": 0,
                "end": 2000,
                "desc": "整幅横切 客厅2.6m落地大主帘 (定高)",
                "airDistance": 1200,
                "startX": 0,
                "startY": 1200,
                "endX": 2000,
                "endY": 1200
            },
            {
                "step": 2,
                "type": "横切",
                "pos": 1570,
                "start": 0,
                "end": 2000,
                "desc": "隔离疵点区后起切 (S型反向往复接刀)",
                "airDistance": 370,
                "startX": 2000,
                "startY": 1570,
                "endX": 0,
                "endY": 1570
            },
            {
                "step": 3,
                "type": "横切",
                "pos": 2770,
                "start": 0,
                "end": 2000,
                "desc": "整幅横切 主卧双开主帘左片 (定高)",
                "airDistance": 1200,
                "startX": 0,
                "startY": 2770,
                "endX": 2000,
                "endY": 2770
            },
            {
                "step": 4,
                "type": "横切",
                "pos": 3320,
                "start": 0,
                "end": 2000,
                "desc": "隔离疵点区后起切 (S型反向往复接刀)",
                "airDistance": 550,
                "startX": 2000,
                "startY": 3320,
                "endX": 0,
                "endY": 3320
            },
            {
                "step": 5,
                "type": "横切",
                "pos": 4520,
                "start": 0,
                "end": 2000,
                "desc": "整幅横切 主卧双开主帘右片 (定高)",
                "airDistance": 1200,
                "startX": 0,
                "startY": 4520,
                "endX": 2000,
                "endY": 4520
            }
        ],
        "deductLen": 4520,
        "pieceArea": 7.2,
        "remArea": 2.8,
        "wasteArea": 0,
        "totalArea": 10,
        "engine": "仅横切顺序排料"
    },
    "2": {
        "name": "案例2: 偏幅单开帘与边角套裁 (43件套 · 边角料吃净连续单)",
        "rollId": "ROLL-DEMO-2D",
        "totalRollL": 30000,
        "bedL": 4000,
        "windowStartY": 0,
        "rollW": 2000,
        "trimStart": 0,
        "cutOrigin": "right-bottom",
        "firstStageOrientation": "vertical",
        "allowRotation": false,
        "allowLongitudinal": true,
        "globalDefects": [
            {
                "id": 1,
                "x": 200,
                "y": 1500,
                "w": 150,
                "h": 600,
                "margin": 50,
                "desc": "左侧0~400mm条带织造破洞与污损"
            }
        ],
        "demands": [
            {
                "id": 1,
                "name": "单开偏幅落地大帘",
                "w": 1400,
                "l": 3800,
                "count": 5
            },
            {
                "id": 2,
                "name": "窗帘造型边饰绑带",
                "w": 150,
                "l": 800,
                "count": 18
            },
            {
                "id": 3,
                "name": "配套同色抱枕套片",
                "w": 450,
                "l": 450,
                "count": 14
            },
            {
                "id": 4,
                "name": "门幅边角飘窗挂帘",
                "w": 600,
                "l": 1200,
                "count": 6
            }
        ],
        "pieces": [
            {
                "demandId": 1,
                "id": 0,
                "l": 3800,
                "name": "单开偏幅落地大帘",
                "rotated": false,
                "w": 1400,
                "x": 600,
                "y": 0
            },
            {
                "demandId": 2,
                "id": 1,
                "l": 800,
                "name": "窗帘造型边饰绑带",
                "rotated": false,
                "w": 150,
                "x": 450,
                "y": 0
            },
            {
                "demandId": 2,
                "id": 2,
                "l": 800,
                "name": "窗帘造型边饰绑带",
                "rotated": false,
                "w": 150,
                "x": 450,
                "y": 800
            },
            {
                "demandId": 2,
                "id": 3,
                "l": 800,
                "name": "窗帘造型边饰绑带",
                "rotated": false,
                "w": 150,
                "x": 450,
                "y": 1600
            },
            {
                "demandId": 3,
                "id": 4,
                "l": 450,
                "name": "配套同色抱枕套片",
                "rotated": false,
                "w": 450,
                "x": 150,
                "y": 2400
            },
            {
                "demandId": 3,
                "id": 5,
                "l": 450,
                "name": "配套同色抱枕套片",
                "rotated": false,
                "w": 450,
                "x": 150,
                "y": 2850
            }
        ],
        "remnants": [
            {
                "id": "REM-PS-01",
                "status": "可用料头",
                "x": 150,
                "y": 0,
                "w": 300,
                "l": 800,
                "area": 0.24,
                "hasDefect": false
            },
            {
                "id": "REM-PS-02",
                "status": "带疵料头",
                "x": 150,
                "y": 800,
                "w": 300,
                "l": 1600,
                "area": 0.48,
                "hasDefect": true
            },
            {
                "id": "REM-PS-03",
                "status": "可用料头",
                "x": 150,
                "y": 3300,
                "w": 450,
                "l": 700,
                "area": 0.315,
                "hasDefect": false
            }
        ],
        "cuts": [
            {
                "step": 1,
                "type": "横切",
                "pos": 3800,
                "start": 600,
                "end": 2000,
                "desc": "第 1 阶段横切，截断落地大帘底边 [1400 × 3800 mm]，完好产出大帘",
                "airDistance": 200,
                "startX": 2000,
                "startY": 3800,
                "endX": 600,
                "endY": 3800
            },
            {
                "step": 2,
                "type": "纵切",
                "pos": 600,
                "start": 0,
                "end": 3800,
                "desc": "第 1 阶段纵切，连续分离大帘与左侧边料套裁区 [600 × 3800 mm]",
                "airDistance": 0,
                "startX": 600,
                "startY": 3800,
                "endX": 600,
                "endY": 0
            },
            {
                "step": 3,
                "type": "纵切",
                "pos": 450,
                "start": 0,
                "end": 2400,
                "desc": "第 2 阶段纵切，分离绑带列与左侧料头区 [150 × 2400 mm]",
                "airDistance": 150,
                "startX": 450,
                "startY": 0,
                "endX": 450,
                "endY": 2400
            },
            {
                "step": 4,
                "type": "横切",
                "pos": 2400,
                "start": 450,
                "end": 600,
                "desc": "第 3 阶段横切，切断绑带 3 底部并产出",
                "airDistance": 0,
                "startX": 450,
                "startY": 2400,
                "endX": 600,
                "endY": 2400
            },
            {
                "step": 5,
                "type": "横切",
                "pos": 1600,
                "start": 450,
                "end": 600,
                "desc": "第 3 阶段横切，切断绑带 2 与绑带 3 (反向接刀)",
                "airDistance": 800,
                "startX": 600,
                "startY": 1600,
                "endX": 450,
                "endY": 1600
            },
            {
                "step": 6,
                "type": "横切",
                "pos": 800,
                "start": 450,
                "end": 600,
                "desc": "第 3 阶段横切，切断绑带 1 与绑带 2",
                "airDistance": 800,
                "startX": 450,
                "startY": 800,
                "endX": 600,
                "endY": 800
            },
            {
                "step": 7,
                "type": "横切",
                "pos": 800,
                "start": 150,
                "end": 450,
                "desc": "第 3 阶段横切，切断可用料头 REM-PS-01 与带疵料头 REM-PS-02",
                "airDistance": 150,
                "startX": 450,
                "startY": 800,
                "endX": 150,
                "endY": 800
            },
            {
                "step": 8,
                "type": "纵切",
                "pos": 150,
                "start": 0,
                "end": 4000,
                "desc": "第 2 阶段纵切，全长隔离左侧疵点废料条带 (0~150mm)",
                "airDistance": 800,
                "startX": 150,
                "startY": 0,
                "endX": 150,
                "endY": 4000
            },
            {
                "step": 9,
                "type": "横切",
                "pos": 3300,
                "start": 150,
                "end": 600,
                "desc": "第 3 阶段横切，切断抱枕 2 与底部可用料头 REM-PS-03",
                "airDistance": 700,
                "startX": 150,
                "startY": 3300,
                "endX": 600,
                "endY": 3300
            },
            {
                "step": 10,
                "type": "横切",
                "pos": 2850,
                "start": 150,
                "end": 600,
                "desc": "第 3 阶段横切，切断抱枕 1 与抱枕 2 (反向接刀)",
                "airDistance": 450,
                "startX": 600,
                "startY": 2850,
                "endX": 150,
                "endY": 2850
            },
            {
                "step": 11,
                "type": "横切",
                "pos": 2400,
                "start": 150,
                "end": 450,
                "desc": "第 3 阶段横切，切断抱枕 1 顶边与上部料头",
                "airDistance": 450,
                "startX": 150,
                "startY": 2400,
                "endX": 450,
                "endY": 2400
            },
            {
                "step": 12,
                "type": "横切",
                "pos": 4000,
                "start": 600,
                "end": 2000,
                "desc": "第 1 阶段工位横切截断刀，在 Y=4000 mm 处将大帘下方料头与长卷截断",
                "airDistance": 1600,
                "startX": 600,
                "startY": 4000,
                "endX": 2000,
                "endY": 4000
            }
        ],
        "deductLen": 3800,
        "pieceArea": 6.085,
        "remArea": 1.035,
        "wasteArea": 0.8800000000000001,
        "totalArea": 8,
        "engine": "直刀二维套裁 (C++ 2D-Guillotine)"
    },
    "3": {
        "name": "案例3: 在库短料料头套裁 (0母卷扣料)",
        "rollId": "ROLL-2026-0920",
        "totalRollL": 1600,
        "bedL": 1600,
        "windowStartY": 0,
        "rollW": 2000,
        "trimStart": 0,
        "cutOrigin": "right-bottom",
        "firstStageOrientation": "horizontal",
        "allowRotation": false,
        "allowLongitudinal": true,
        "globalDefects": [],
        "demands": [
            {
                "id": 1,
                "name": "次卧飘窗短帘主片",
                "w": 1200,
                "l": 1000,
                "count": 1
            },
            {
                "id": 2,
                "name": "同款沙发抱枕套片",
                "w": 450,
                "l": 450,
                "count": 2
            },
            {
                "id": 3,
                "name": "窗帘立体定型绑带",
                "w": 150,
                "l": 650,
                "count": 2
            }
        ],
        "pieces": [
            {
                "demandId": 1,
                "id": 0,
                "l": 1000,
                "name": "次卧飘窗短帘主片",
                "rotated": false,
                "w": 1200,
                "x": 800,
                "y": 600
            },
            {
                "demandId": 2,
                "id": 1,
                "l": 450,
                "name": "同款沙发抱枕套片",
                "rotated": false,
                "w": 450,
                "x": 350,
                "y": 1150
            },
            {
                "demandId": 2,
                "id": 2,
                "l": 450,
                "name": "同款沙发抱枕套片",
                "rotated": false,
                "w": 450,
                "x": 350,
                "y": 700
            },
            {
                "demandId": 3,
                "id": 3,
                "l": 650,
                "name": "窗帘立体定型绑带",
                "rotated": false,
                "w": 150,
                "x": 200,
                "y": 950
            },
            {
                "demandId": 3,
                "id": 4,
                "l": 650,
                "name": "窗帘立体定型绑带",
                "rotated": false,
                "w": 150,
                "x": 50,
                "y": 950
            }
        ],
        "remnants": [
            {
                "id": "REM-PS-01",
                "status": "可用料头",
                "x": 50,
                "y": 600,
                "w": 300,
                "l": 350,
                "area": 0.105,
                "hasDefect": false
            },
            {
                "id": "REM-PS-02",
                "status": "可用料头",
                "x": 0,
                "y": 0,
                "w": 2000,
                "l": 600,
                "area": 1.2,
                "hasDefect": false
            }
        ],
        "cuts": [
            {
                "step": 1,
                "type": "纵切",
                "pos": 800,
                "start": 600,
                "end": 1600,
                "desc": "第 2 阶段纵切，切断飘窗短帘左边界 [1200 × 1000 mm]",
                "airDistance": 200,
                "startX": 800,
                "startY": 1600,
                "endX": 800,
                "endY": 600
            },
            {
                "step": 2,
                "type": "横切",
                "pos": 600,
                "start": 800,
                "end": 2000,
                "desc": "第 1 阶段横切，截断短帘顶边并分离上部可用料头 REM-PS-02",
                "airDistance": 0,
                "startX": 800,
                "startY": 600,
                "endX": 2000,
                "endY": 600
            },
            {
                "step": 3,
                "type": "横切",
                "pos": 600,
                "start": 0,
                "end": 800,
                "desc": "第 1 阶段横切，连续切断左半部料头顶边 (0~800mm)",
                "airDistance": 1200,
                "startX": 800,
                "startY": 600,
                "endX": 0,
                "endY": 600
            },
            {
                "step": 4,
                "type": "纵切",
                "pos": 350,
                "start": 600,
                "end": 1600,
                "desc": "第 2 阶段纵切，分离抱枕列与绑带区 [450 × 1000 mm]",
                "airDistance": 350,
                "startX": 350,
                "startY": 600,
                "endX": 350,
                "endY": 1600
            },
            {
                "step": 5,
                "type": "横切",
                "pos": 1150,
                "start": 350,
                "end": 800,
                "desc": "第 3 阶段横切，切断抱枕 1 与抱枕 2",
                "airDistance": 450,
                "startX": 350,
                "startY": 1150,
                "endX": 800,
                "endY": 1150
            },
            {
                "step": 6,
                "type": "横切",
                "pos": 700,
                "start": 350,
                "end": 800,
                "desc": "第 3 阶段横切，切断抱枕 2 顶边与上部边料 (反向接刀)",
                "airDistance": 450,
                "startX": 800,
                "startY": 700,
                "endX": 350,
                "endY": 700
            },
            {
                "step": 7,
                "type": "纵切",
                "pos": 50,
                "start": 600,
                "end": 1600,
                "desc": "第 2 阶段纵切，切除左侧边料 (0~50mm)",
                "airDistance": 320,
                "startX": 50,
                "startY": 600,
                "endX": 50,
                "endY": 1600
            },
            {
                "step": 8,
                "type": "横切",
                "pos": 950,
                "start": 50,
                "end": 350,
                "desc": "第 3 阶段横切，切断绑带 1、2 顶边与可用料头 REM-PS-01",
                "airDistance": 650,
                "startX": 50,
                "startY": 950,
                "endX": 350,
                "endY": 950
            },
            {
                "step": 9,
                "type": "纵切",
                "pos": 200,
                "start": 950,
                "end": 1600,
                "desc": "第 3 阶段纵切，切断绑带 1 与绑带 2 并完工产出",
                "airDistance": 150,
                "startX": 200,
                "startY": 950,
                "endX": 200,
                "endY": 1600
            }
        ],
        "deductLen": 0,
        "pieceArea": 1.8,
        "remArea": 1.305,
        "wasteArea": 0.0950000000000002,
        "totalArea": 3.2,
        "engine": "料头精益复用调度器 (母卷0消耗)"
    },
    "4": {
        "name": "案例4: 窗幔帘头辅件套裁 (74件套 · 多工位连续套裁大单)",
        "rollId": "ROLL-2026-0920",
        "totalRollL": 60000,
        "bedL": 4500,
        "windowStartY": 0,
        "rollW": 2000,
        "trimStart": 0,
        "cutOrigin": "right-bottom",
        "firstStageOrientation": "horizontal",
        "allowRotation": false,
        "allowLongitudinal": true,
        "globalDefects": [
            {
                "id": 1,
                "x": 500,
                "y": 1400,
                "w": 150,
                "h": 150,
                "margin": 30,
                "desc": "色斑瑕疵 (强制避让)"
            }
        ],
        "demands": [
            {
                "id": 1,
                "name": "客厅大水波造型幔",
                "w": 800,
                "l": 1200,
                "count": 12
            },
            {
                "id": 2,
                "name": "次卧小垂花平幔",
                "w": 600,
                "l": 1000,
                "count": 12
            },
            {
                "id": 3,
                "name": "窗帘立体造型绑带",
                "w": 200,
                "l": 800,
                "count": 24
            },
            {
                "id": 4,
                "name": "同款沙发布抱枕套",
                "w": 450,
                "l": 450,
                "count": 16
            },
            {
                "id": 5,
                "name": "欧式窗幔压边挂条",
                "w": 300,
                "l": 800,
                "count": 10
            }
        ],
        "pieces": [
            {
                "demandId": 1,
                "id": 0,
                "l": 1200,
                "name": "客厅大水波造型幔",
                "rotated": false,
                "w": 800,
                "x": 1200,
                "y": 0
            },
            {
                "demandId": 1,
                "id": 1,
                "l": 1200,
                "name": "客厅大水波造型幔",
                "rotated": false,
                "w": 800,
                "x": 400,
                "y": 0
            },
            {
                "demandId": 2,
                "id": 2,
                "l": 1000,
                "name": "次卧小垂花平幔",
                "rotated": false,
                "w": 600,
                "x": 1400,
                "y": 1200
            },
            {
                "demandId": 2,
                "id": 3,
                "l": 1000,
                "name": "次卧小垂花平幔",
                "rotated": false,
                "w": 600,
                "x": 800,
                "y": 1200
            },
            {
                "demandId": 3,
                "id": 4,
                "l": 800,
                "name": "窗帘立体造型绑带",
                "rotated": false,
                "w": 200,
                "x": 270,
                "y": 1200
            },
            {
                "demandId": 3,
                "id": 5,
                "l": 800,
                "name": "窗帘立体造型绑带",
                "rotated": false,
                "w": 200,
                "x": 70,
                "y": 1200
            },
            {
                "demandId": 3,
                "id": 6,
                "l": 800,
                "name": "窗帘立体造型绑带",
                "rotated": false,
                "w": 200,
                "x": 1800,
                "y": 2200
            },
            {
                "demandId": 3,
                "id": 7,
                "l": 800,
                "name": "窗帘立体造型绑带",
                "rotated": false,
                "w": 200,
                "x": 1600,
                "y": 2200
            },
            {
                "demandId": 4,
                "id": 8,
                "l": 450,
                "name": "同款沙发布抱枕套",
                "rotated": false,
                "w": 450,
                "x": 1150,
                "y": 2200
            },
            {
                "demandId": 4,
                "id": 9,
                "l": 450,
                "name": "同款沙发布抱枕套",
                "rotated": false,
                "w": 450,
                "x": 700,
                "y": 2200
            }
        ],
        "remnants": [
            {
                "id": "REM-PS-01",
                "status": "可用料头",
                "x": 0,
                "y": 0,
                "w": 400,
                "l": 1200,
                "area": 0.48,
                "hasDefect": false
            },
            {
                "id": "REM-PS-02",
                "status": "带疵料头",
                "x": 470,
                "y": 1200,
                "w": 330,
                "l": 1000,
                "area": 0.33,
                "hasDefect": true
            },
            {
                "id": "REM-PS-03",
                "status": "可用料头",
                "x": 700,
                "y": 2650,
                "w": 900,
                "l": 350,
                "area": 0.315,
                "hasDefect": false
            },
            {
                "id": "REM-PS-04",
                "status": "可用料头",
                "x": 0,
                "y": 2200,
                "w": 700,
                "l": 800,
                "area": 0.56,
                "hasDefect": false
            },
            {
                "id": "REM-PS-05",
                "status": "可用料头",
                "x": 0,
                "y": 3000,
                "w": 2000,
                "l": 1500,
                "area": 3,
                "hasDefect": false
            }
        ],
        "cuts": [
            {
                "step": 1,
                "type": "横切",
                "pos": 3000,
                "start": 0,
                "end": 2000,
                "desc": "第 1 阶段全幅横切，分离 3.0m 上部裁切区与下部可用料头 REM-PS-05",
                "airDistance": 1500,
                "startX": 2000,
                "startY": 3000,
                "endX": 0,
                "endY": 3000
            },
            {
                "step": 2,
                "type": "横切",
                "pos": 2200,
                "start": 0,
                "end": 2000,
                "desc": "第 1 阶段全幅横切 (S型反向往复接刀)，分离条带 2 与条带 3",
                "airDistance": 800,
                "startX": 0,
                "startY": 2200,
                "endX": 2000,
                "endY": 2200
            },
            {
                "step": 3,
                "type": "横切",
                "pos": 1200,
                "start": 0,
                "end": 2000,
                "desc": "第 1 阶段全幅横切 (S型反向往复接刀)，分离条带 1 与条带 2",
                "airDistance": 1000,
                "startX": 2000,
                "startY": 1200,
                "endX": 0,
                "endY": 1200
            },
            {
                "step": 4,
                "type": "纵切",
                "pos": 400,
                "start": 0,
                "end": 1200,
                "desc": "第 2 阶段纵切，切开左侧可用料头 REM-PS-01",
                "airDistance": 400,
                "startX": 400,
                "startY": 0,
                "endX": 400,
                "endY": 1200
            },
            {
                "step": 5,
                "type": "纵切",
                "pos": 1200,
                "start": 0,
                "end": 1200,
                "desc": "第 2 阶段纵切，切断大水波造型幔 1 与 2 并完工产出",
                "airDistance": 800,
                "startX": 1200,
                "startY": 1200,
                "endX": 1200,
                "endY": 0
            },
            {
                "step": 6,
                "type": "纵切",
                "pos": 1400,
                "start": 1200,
                "end": 2200,
                "desc": "第 2 阶段纵切，切断平幔 1 与平幔 2",
                "airDistance": 1200,
                "startX": 1400,
                "startY": 1200,
                "endX": 1400,
                "endY": 2200
            },
            {
                "step": 7,
                "type": "纵切",
                "pos": 800,
                "start": 1200,
                "end": 2200,
                "desc": "第 2 阶段纵切，切断平幔 2 与带疵料头 REM-PS-02",
                "airDistance": 600,
                "startX": 800,
                "startY": 2200,
                "endX": 800,
                "endY": 1200
            },
            {
                "step": 8,
                "type": "纵切",
                "pos": 470,
                "start": 1200,
                "end": 2200,
                "desc": "第 2 阶段纵切，切除带疵料头左边界",
                "airDistance": 330,
                "startX": 470,
                "startY": 1200,
                "endX": 470,
                "endY": 2200
            },
            {
                "step": 9,
                "type": "纵切",
                "pos": 270,
                "start": 1200,
                "end": 2200,
                "desc": "第 2 阶段纵切，切断绑带 1 与料头",
                "airDistance": 200,
                "startX": 270,
                "startY": 2200,
                "endX": 270,
                "endY": 1200
            },
            {
                "step": 10,
                "type": "纵切",
                "pos": 70,
                "start": 1200,
                "end": 2200,
                "desc": "第 2 阶段纵切，切断绑带 2 与左边料",
                "airDistance": 200,
                "startX": 70,
                "startY": 1200,
                "endX": 70,
                "endY": 2200
            },
            {
                "step": 11,
                "type": "横切",
                "pos": 2000,
                "start": 70,
                "end": 470,
                "desc": "第 3 阶段横切，切断绑带底边与下料头",
                "airDistance": 200,
                "startX": 70,
                "startY": 2000,
                "endX": 470,
                "endY": 2000
            },
            {
                "step": 12,
                "type": "纵切",
                "pos": 1800,
                "start": 2200,
                "end": 3000,
                "desc": "第 2 阶段纵切，切断绑带 3 与右边料",
                "airDistance": 1330,
                "startX": 1800,
                "startY": 2200,
                "endX": 1800,
                "endY": 3000
            },
            {
                "step": 13,
                "type": "纵切",
                "pos": 1600,
                "start": 2200,
                "end": 3000,
                "desc": "第 2 阶段纵切，切断绑带 4 与绑带 3",
                "airDistance": 200,
                "startX": 1600,
                "startY": 3000,
                "endX": 1600,
                "endY": 2200
            },
            {
                "step": 14,
                "type": "纵切",
                "pos": 1150,
                "start": 2200,
                "end": 2650,
                "desc": "第 3 阶段纵切，切断抱枕 1 与抱枕 2",
                "airDistance": 450,
                "startX": 1150,
                "startY": 2200,
                "endX": 1150,
                "endY": 2650
            },
            {
                "step": 15,
                "type": "纵切",
                "pos": 700,
                "start": 2200,
                "end": 2650,
                "desc": "第 3 阶段纵切，切断抱枕 2 与左料头 REM-PS-04",
                "airDistance": 450,
                "startX": 700,
                "startY": 2650,
                "endX": 700,
                "endY": 2200
            },
            {
                "step": 16,
                "type": "横切",
                "pos": 2650,
                "start": 700,
                "end": 1600,
                "desc": "第 3 阶段横切，切断抱枕底边与下料头 REM-PS-03",
                "airDistance": 450,
                "startX": 700,
                "startY": 2650,
                "endX": 1600,
                "endY": 2650
            }
        ],
        "deductLen": 3000,
        "pieceArea": 4.165,
        "remArea": 4.6850000000000005,
        "wasteArea": 0.14999999999999947,
        "totalArea": 9,
        "engine": "智能几何排料内核 (C++ 2D-Guillotine)"
    },
    "5": {
        "name": "案例5: Word 经典 L形拆解 (12件工程单 · 面积严密守恒)",
        "rollId": "ROLL-2026-0920",
        "totalRollL": 30000,
        "bedL": 4000,
        "windowStartY": 0,
        "rollW": 2000,
        "trimStart": 0,
        "cutOrigin": "right-bottom",
        "firstStageOrientation": "horizontal",
        "allowRotation": false,
        "allowLongitudinal": true,
        "globalDefects": [],
        "demands": [
            {
                "id": 1,
                "name": "工程落地主帘大板 (Word标准件)",
                "w": 1500,
                "l": 3000,
                "count": 6
            },
            {
                "id": 2,
                "name": "边角同色定型挂带 (Word辅件)",
                "w": 450,
                "l": 1000,
                "count": 6
            }
        ],
        "pieces": [
            {
                "id": 1,
                "demandId": 1,
                "name": "工程落地主帘大板 (Word标准件)",
                "x": 500,
                "y": 1000,
                "w": 1500,
                "l": 3000
            }
        ],
        "remnants": [
            {
                "id": "REM-01",
                "status": "左侧可用料头",
                "x": 0,
                "y": 0,
                "w": 500,
                "l": 4000,
                "area": 2,
                "hasDefect": false
            },
            {
                "id": "REM-02",
                "status": "上方末端料头",
                "x": 500,
                "y": 0,
                "w": 1500,
                "l": 1000,
                "area": 1.5,
                "hasDefect": false
            }
        ],
        "cuts": [
            {
                "step": 1,
                "type": "纵切",
                "pos": 500,
                "start": 0,
                "end": 4000,
                "desc": "在宽度500mm处纵切到底，切出左侧料头(0.5m×4m)",
                "airDistance": 1500,
                "startX": 500,
                "startY": 4000,
                "endX": 500,
                "endY": 0
            },
            {
                "step": 2,
                "type": "横切",
                "pos": 1000,
                "start": 500,
                "end": 2000,
                "desc": "在展开1000mm处横切断刀，切出上方料头(1.5m×1m)，产出靠右下角的标准成品",
                "airDistance": 1000,
                "startX": 500,
                "startY": 1000,
                "endX": 2000,
                "endY": 1000
            }
        ],
        "deductLen": 4000,
        "pieceArea": 4.5,
        "remArea": 3.5,
        "wasteArea": 0,
        "totalArea": 8,
        "engine": "Word 规范精确拆解引擎"
    },
    "6": {
        "name": "案例6: 60m大卷多工位搭切 (108件套客房工程全貌 · 支持全卷连续搭切)",
        "rollId": "ROLL-2026-0920",
        "totalRollL": 60000,
        "bedL": 5000,
        "windowStartY": 0,
        "rollW": 2000,
        "trimStart": 0,
        "cutOrigin": "right-bottom",
        "firstStageOrientation": "horizontal",
        "allowRotation": false,
        "allowLongitudinal": true,
        "globalDefects": [
            {
                "id": 1,
                "x": 500,
                "y": 1400,
                "w": 150,
                "h": 150,
                "margin": 30,
                "desc": "台面第1疵点 (色斑)"
            },
            {
                "id": 2,
                "x": 1300,
                "y": 3200,
                "w": 200,
                "h": 100,
                "margin": 30,
                "desc": "台面第2疵点 (抽纱)"
            },
            {
                "id": 3,
                "x": 600,
                "y": 8400,
                "w": 180,
                "h": 120,
                "margin": 30,
                "desc": "进料第3疵点 (未展开 8.4m)"
            },
            {
                "id": 4,
                "x": 1400,
                "y": 14200,
                "w": 220,
                "h": 150,
                "margin": 40,
                "desc": "进料第4疵点 (未展开 14.2m 破洞)"
            },
            {
                "id": 5,
                "x": 400,
                "y": 22000,
                "w": 150,
                "h": 300,
                "margin": 30,
                "desc": "进料第5疵点 (未展开 22.0m 经向条痕)"
            },
            {
                "id": 6,
                "x": 1100,
                "y": 31500,
                "w": 160,
                "h": 160,
                "margin": 30,
                "desc": "进料第6疵点 (未展开 31.5m 污渍)"
            },
            {
                "id": 7,
                "x": 800,
                "y": 42000,
                "w": 200,
                "h": 200,
                "margin": 40,
                "desc": "进料第7疵点 (未展开 42.0m 稀密路)"
            },
            {
                "id": 8,
                "x": 300,
                "y": 53800,
                "w": 120,
                "h": 180,
                "margin": 30,
                "desc": "进料第8疵点 (未展开 53.8m 飞纱)"
            }
        ],
        "demands": [
            {
                "id": 1,
                "name": "标房落地主帘",
                "w": 800,
                "l": 1200,
                "count": 24
            },
            {
                "id": 2,
                "name": "套房侧帘拼片",
                "w": 600,
                "l": 1000,
                "count": 24
            },
            {
                "id": 3,
                "name": "客房装饰绑带",
                "w": 200,
                "l": 800,
                "count": 32
            },
            {
                "id": 4,
                "name": "客房飘窗短帘",
                "w": 1000,
                "l": 800,
                "count": 12
            },
            {
                "id": 5,
                "name": "同色阻燃抱枕套",
                "w": 450,
                "l": 450,
                "count": 16
            }
        ],
        "pieces": [
            {
                "demandId": 1,
                "id": 0,
                "l": 1200,
                "name": "标房落地主帘",
                "rotated": false,
                "w": 800,
                "x": 1200,
                "y": 0
            },
            {
                "demandId": 1,
                "id": 1,
                "l": 1200,
                "name": "标房落地主帘",
                "rotated": false,
                "w": 800,
                "x": 400,
                "y": 0
            },
            {
                "demandId": 1,
                "id": 2,
                "l": 1200,
                "name": "标房落地主帘",
                "rotated": false,
                "w": 800,
                "x": 1200,
                "y": 1580
            },
            {
                "demandId": 1,
                "id": 3,
                "l": 1200,
                "name": "标房落地主帘",
                "rotated": false,
                "w": 800,
                "x": 400,
                "y": 1580
            },
            {
                "demandId": 2,
                "id": 4,
                "l": 1000,
                "name": "套房侧帘拼片",
                "rotated": false,
                "w": 600,
                "x": 1400,
                "y": 3330
            },
            {
                "demandId": 2,
                "id": 5,
                "l": 1000,
                "name": "套房侧帘拼片",
                "rotated": false,
                "w": 600,
                "x": 800,
                "y": 3330
            },
            {
                "demandId": 2,
                "id": 6,
                "l": 1000,
                "name": "套房侧帘拼片",
                "rotated": false,
                "w": 600,
                "x": 200,
                "y": 2780
            },
            {
                "demandId": 2,
                "id": 7,
                "l": 1000,
                "name": "套房侧帘拼片",
                "rotated": false,
                "w": 600,
                "x": 200,
                "y": 3780
            },
            {
                "demandId": 3,
                "id": 8,
                "l": 800,
                "name": "客房装饰绑带",
                "rotated": false,
                "w": 200,
                "x": 0,
                "y": 2780
            },
            {
                "demandId": 3,
                "id": 9,
                "l": 800,
                "name": "客房装饰绑带",
                "rotated": false,
                "w": 200,
                "x": 0,
                "y": 3580
            }
        ],
        "remnants": [
            {
                "id": "REM-PS-01",
                "status": "带疵料头",
                "x": 400,
                "y": 1200,
                "w": 1600,
                "l": 380,
                "area": 0.608,
                "hasDefect": true
            },
            {
                "id": "REM-PS-02",
                "status": "可用料头",
                "x": 0,
                "y": 0,
                "w": 400,
                "l": 2780,
                "area": 1.112,
                "hasDefect": false
            },
            {
                "id": "REM-PS-03",
                "status": "带疵料头",
                "x": 800,
                "y": 2780,
                "w": 1200,
                "l": 550,
                "area": 0.66,
                "hasDefect": true
            },
            {
                "id": "REM-PS-04",
                "status": "可用料头",
                "x": 800,
                "y": 4330,
                "w": 1200,
                "l": 450,
                "area": 0.54,
                "hasDefect": false
            },
            {
                "id": "REM-PS-05",
                "status": "可用料头",
                "x": 0,
                "y": 4380,
                "w": 200,
                "l": 400,
                "area": 0.08,
                "hasDefect": false
            }
        ],
        "cuts": [
            {
                "step": 1,
                "type": "横切",
                "pos": 4780,
                "start": 0,
                "end": 2000,
                "desc": "第 1 阶段全幅横切，截断当前工位长卷落料边界 [2000 × 4780 mm]",
                "airDistance": 220,
                "startX": 2000,
                "startY": 4780,
                "endX": 0,
                "endY": 4780
            },
            {
                "step": 2,
                "type": "横切",
                "pos": 2780,
                "start": 0,
                "end": 2000,
                "desc": "第 1 阶段全幅横切 (S型反向往复接刀)，分离工位上半区与下半区",
                "airDistance": 2000,
                "startX": 0,
                "startY": 2780,
                "endX": 2000,
                "endY": 2780
            },
            {
                "step": 3,
                "type": "纵切",
                "pos": 400,
                "start": 0,
                "end": 2780,
                "desc": "第 2 阶段纵切，分离左侧可用料头 REM-PS-02 与主帘区",
                "airDistance": 1600,
                "startX": 400,
                "startY": 2780,
                "endX": 400,
                "endY": 0
            },
            {
                "step": 4,
                "type": "横切",
                "pos": 1200,
                "start": 400,
                "end": 2000,
                "desc": "第 3 阶段横切，切断主帘 1、2 顶边与带疵料头 REM-PS-01",
                "airDistance": 1200,
                "startX": 400,
                "startY": 1200,
                "endX": 2000,
                "endY": 1200
            },
            {
                "step": 5,
                "type": "横切",
                "pos": 1580,
                "start": 400,
                "end": 2000,
                "desc": "第 3 阶段横切 (S型反向接刀)，切断主帘 3、4 顶边与料头 REM-PS-01",
                "airDistance": 380,
                "startX": 2000,
                "startY": 1580,
                "endX": 400,
                "endY": 1580
            },
            {
                "step": 6,
                "type": "纵切",
                "pos": 1200,
                "start": 1580,
                "end": 2780,
                "desc": "第 3 阶段纵切，切断主帘 3 与主帘 4",
                "airDistance": 800,
                "startX": 1200,
                "startY": 1580,
                "endX": 1200,
                "endY": 2780
            },
            {
                "step": 7,
                "type": "纵切",
                "pos": 1200,
                "start": 0,
                "end": 1200,
                "desc": "第 3 阶段纵切，切断主帘 1 与主帘 2",
                "airDistance": 380,
                "startX": 1200,
                "startY": 1200,
                "endX": 1200,
                "endY": 0
            },
            {
                "step": 8,
                "type": "纵切",
                "pos": 800,
                "start": 2780,
                "end": 4780,
                "desc": "第 2 阶段纵切，切开下半区套房侧帘与左侧绑带区",
                "airDistance": 1600,
                "startX": 800,
                "startY": 2780,
                "endX": 800,
                "endY": 4780
            },
            {
                "step": 9,
                "type": "纵切",
                "pos": 1400,
                "start": 3330,
                "end": 4330,
                "desc": "第 3 阶段纵切，切开套房侧帘 1 与侧帘 2",
                "airDistance": 600,
                "startX": 1400,
                "startY": 4330,
                "endX": 1400,
                "endY": 3330
            },
            {
                "step": 10,
                "type": "横切",
                "pos": 3330,
                "start": 800,
                "end": 2000,
                "desc": "第 3 阶段横切，切断侧帘 1、2 顶边与带疵料头 REM-PS-03",
                "airDistance": 600,
                "startX": 1400,
                "startY": 3330,
                "endX": 2000,
                "endY": 3330
            },
            {
                "step": 11,
                "type": "横切",
                "pos": 4330,
                "start": 800,
                "end": 2000,
                "desc": "第 3 阶段横切 (S型反向接刀)，切断侧帘 1、2 底边与可用料头 REM-PS-04",
                "airDistance": 1000,
                "startX": 2000,
                "startY": 4330,
                "endX": 800,
                "endY": 4330
            },
            {
                "step": 12,
                "type": "纵切",
                "pos": 200,
                "start": 2780,
                "end": 4780,
                "desc": "第 2 阶段纵切，切开侧帘 3、4 与左侧绑带列",
                "airDistance": 600,
                "startX": 200,
                "startY": 4780,
                "endX": 200,
                "endY": 2780
            },
            {
                "step": 13,
                "type": "横切",
                "pos": 3780,
                "start": 200,
                "end": 800,
                "desc": "第 3 阶段横切，切断侧帘 3 与侧帘 4",
                "airDistance": 1000,
                "startX": 200,
                "startY": 3780,
                "endX": 800,
                "endY": 3780
            },
            {
                "step": 14,
                "type": "横切",
                "pos": 3580,
                "start": 0,
                "end": 200,
                "desc": "第 3 阶段横切，切断绑带 1 与绑带 2",
                "airDistance": 600,
                "startX": 200,
                "startY": 3580,
                "endX": 0,
                "endY": 3580
            },
            {
                "step": 15,
                "type": "横切",
                "pos": 4380,
                "start": 0,
                "end": 200,
                "desc": "第 3 阶段横切，切断绑带 2 底边与可用料头 REM-PS-05",
                "airDistance": 800,
                "startX": 0,
                "startY": 4380,
                "endX": 200,
                "endY": 4380
            }
        ],
        "deductLen": 4780,
        "pieceArea": 6.56,
        "remArea": 3.0000000000000004,
        "wasteArea": 0.43999999999999995,
        "totalArea": 10,
        "engine": "智能几何排料内核 (多工位搭切)"
    }
};

/**
 * 深拷贝预设案例，避免状态被永久污染
 */
export function getInitialScenarios() {
    return JSON.parse(JSON.stringify(INITIAL_SCENARIOS));
}
