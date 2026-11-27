export const SCENARIOS_GROUP_B = {
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
                "id": "REM-S1-01",
                "status": "可用料头",
                "x": 50,
                "y": 600,
                "w": 300,
                "l": 350,
                "area": 0.105,
                "hasDefect": false
            },
            {
                "id": "REM-S1-02",
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
                "desc": "第 1 阶段横切，截断短帘顶边并分离上部可用料头 REM-S1-02",
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
                "desc": "第 3 阶段横切，切断绑带 1、2 顶边与可用料头 REM-S1-01",
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
                "id": "REM-S1-01",
                "status": "可用料头",
                "x": 0,
                "y": 0,
                "w": 400,
                "l": 1200,
                "area": 0.48,
                "hasDefect": false
            },
            {
                "id": "REM-S1-02",
                "status": "带疵料头",
                "x": 470,
                "y": 1200,
                "w": 330,
                "l": 1000,
                "area": 0.33,
                "hasDefect": true
            },
            {
                "id": "REM-S1-03",
                "status": "可用料头",
                "x": 700,
                "y": 2650,
                "w": 900,
                "l": 350,
                "area": 0.315,
                "hasDefect": false
            },
            {
                "id": "REM-S1-04",
                "status": "可用料头",
                "x": 0,
                "y": 2200,
                "w": 700,
                "l": 800,
                "area": 0.56,
                "hasDefect": false
            },
            {
                "id": "REM-S1-05",
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
                "desc": "第 1 阶段全幅横切，分离 3.0m 上部裁切区与下部可用料头 REM-S1-05",
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
                "desc": "第 2 阶段纵切，切开左侧可用料头 REM-S1-01",
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
                "desc": "第 2 阶段纵切，切断平幔 2 与带疵料头 REM-S1-02",
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
                "desc": "第 3 阶段纵切，切断抱枕 2 与左料头 REM-S1-04",
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
                "desc": "第 3 阶段横切，切断抱枕底边与下料头 REM-S1-03",
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
};
