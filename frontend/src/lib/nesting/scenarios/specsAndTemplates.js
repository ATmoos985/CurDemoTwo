/** 母卷规格与窗帘订单预设模板 */

export const MOTHER_ROLL_SPECS = {
    "ROLL-2026-0920": { model: "TC涤棉-B2026", rollW: 2000, totalRollL: 60000, bedL: 5000 },
    "ROLL-2026-0921": { model: "纯棉斜纹-C1800", rollW: 1800, totalRollL: 50000, bedL: 5000 },
    "ROLL-2026-0922": { model: "弹力牛津-O2200", rollW: 2200, totalRollL: 80000, bedL: 5000 },
    "ROLL-DEMO-2D": { model: "窗帘样布-2D", rollW: 2000, totalRollL: 30000, bedL: 4000 },
    "ROLL-REAL-893292": { model: "2#A3A-Cream", rollW: 2800, totalRollL: 100000, bedL: 5000 },
    "ROLL-REAL-893153": { model: "2#1A-Off White", rollW: 2800, totalRollL: 100000, bedL: 5000 }
};

export const CURTAIN_ORDER_TEMPLATES = {
    "real_893292_cream": {
        name: "🏆 真实面料 893292 (2#A3A-Cream) 窗帘整单 (11主帘+3辅件 · 37件套)",
        desc: "归属母卷 ROLL-REAL-893292 · 涵盖 11 项落地与飘窗主帘 (定高横裁) + 3 项窗幔绑带抱枕 (边料竖切套排)",
        demands: [
            { id: 1, name: "订单5_客餐厅双开大主帘", width: 2170, length: 3250, count: 2 },
            { id: 2, name: "订单6_次卧双开大主帘", width: 2170, length: 3570, count: 2 },
            { id: 3, name: "订单7_书房单开主帘", width: 2220, length: 1620, count: 1 },
            { id: 4, name: "订单8_挑空大厅超高主帘", width: 2715, length: 2930, count: 4 },
            { id: 5, name: "订单9_主卧双开主帘", width: 2220, length: 2260, count: 2 },
            { id: 6, name: "订单10_客卧单开主帘", width: 2220, length: 2260, count: 1 },
            { id: 7, name: "订单11_衣帽间单开主帘", width: 2220, length: 2930, count: 1 },
            { id: 8, name: "订单12_儿童房飘窗短帘", width: 1603, length: 2260, count: 4 },
            { id: 9, name: "订单13_书房小窗短帘", width: 1500, length: 3250, count: 2 },
            { id: 10, name: "订单14_会客大厅超宽主帘", width: 2640, length: 4470, count: 2 },
            { id: 11, name: "订单15_主卫采光主帘", width: 2660, length: 2355, count: 2 },
            { id: 12, name: "配套提花定型窗幔", width: 400, length: 1600, count: 4 },
            { id: 13, name: "同色窗帘立体造型绑带", width: 180, length: 800, count: 6 },
            { id: 14, name: "同款面料沙发抱枕套", width: 450, length: 450, count: 4 }
        ]
    },
    "real_893153_white": {
        name: "🏆 真实面料 893153 (2#1A-Off White) 窗帘整单 (4大工程主帘+2辅件 · 18件套)",
        desc: "归属母卷 ROLL-REAL-893153 · 涵盖 4 大工程落地大帘 (定高横裁) + 边料长绑带与抱枕 (边料竖切套排)",
        demands: [
            { id: 1, name: "订单1_客房整幅大帘", width: 2413, length: 5490, count: 1 },
            { id: 2, name: "订单2_宴会厅超长大帘", width: 2417, length: 9070, count: 1 },
            { id: 3, name: "订单3_标房双开落地帘", width: 2230, length: 6800, count: 1 },
            { id: 4, name: "订单4_景观套房大帘", width: 2403, length: 7440, count: 1 },
            { id: 5, name: "边饰定型长绑带", width: 200, length: 800, count: 8 },
            { id: 6, name: "配套同色抱枕套片", width: 450, length: 450, count: 6 }
        ]
    },
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
