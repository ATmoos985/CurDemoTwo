export const SCENARIOS_GROUP_A = {
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
                "id": "REM-S1-01",
                "status": "可用料头",
                "x": 150,
                "y": 0,
                "w": 300,
                "l": 800,
                "area": 0.24,
                "hasDefect": false
            },
            {
                "id": "REM-S1-02",
                "status": "带疵料头",
                "x": 150,
                "y": 800,
                "w": 300,
                "l": 1600,
                "area": 0.48,
                "hasDefect": true
            },
            {
                "id": "REM-S1-03",
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
                "desc": "第 3 阶段横切，切断可用料头 REM-S1-01 与带疵料头 REM-S1-02",
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
                "desc": "第 3 阶段横切，切断抱枕 2 与底部可用料头 REM-S1-03",
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
};
