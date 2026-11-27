export const SCENARIOS_GROUP_C = {
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
                "id": "REM-S1-01",
                "status": "带疵料头",
                "x": 400,
                "y": 1200,
                "w": 1600,
                "l": 380,
                "area": 0.608,
                "hasDefect": true
            },
            {
                "id": "REM-S1-02",
                "status": "可用料头",
                "x": 0,
                "y": 0,
                "w": 400,
                "l": 2780,
                "area": 1.112,
                "hasDefect": false
            },
            {
                "id": "REM-S1-03",
                "status": "带疵料头",
                "x": 800,
                "y": 2780,
                "w": 1200,
                "l": 550,
                "area": 0.66,
                "hasDefect": true
            },
            {
                "id": "REM-S1-04",
                "status": "可用料头",
                "x": 800,
                "y": 4330,
                "w": 1200,
                "l": 450,
                "area": 0.54,
                "hasDefect": false
            },
            {
                "id": "REM-S1-05",
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
                "desc": "第 2 阶段纵切，分离左侧可用料头 REM-S1-02 与主帘区",
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
                "desc": "第 3 阶段横切，切断主帘 1、2 顶边与带疵料头 REM-S1-01",
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
                "desc": "第 3 阶段横切 (S型反向接刀)，切断主帘 3、4 顶边与料头 REM-S1-01",
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
                "desc": "第 3 阶段横切，切断侧帘 1、2 顶边与带疵料头 REM-S1-03",
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
                "desc": "第 3 阶段横切 (S型反向接刀)，切断侧帘 1、2 底边与可用料头 REM-S1-04",
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
                "desc": "第 3 阶段横切，切断绑带 2 底边与可用料头 REM-S1-05",
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
    },
};
