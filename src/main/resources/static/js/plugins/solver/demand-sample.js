// 9.28.xlsx 的有效 RH 行；仅保留材料、尺寸、件数和来源行，不含客户订单编号。
export const demandSample = {
    format:"9.28 订单格式 · cm → mm", issues:[], excludedRows:[78,79,108,109],
    groups:[
        {materialModel:"2#1A-Off White", demands:[
            {"id":6,"row":6,"name":"9.28 第 6 行","width":2413,"length":5490,"quantity":1,"allowRotation":false,"note":"最多拼接 2 片；保留整片需求，未自动拆片"},
            {"id":7,"row":7,"name":"9.28 第 7 行","width":2417,"length":9070,"quantity":1,"allowRotation":false,"note":"最多拼接 4 片；保留整片需求，未自动拆片"},
            {"id":8,"row":8,"name":"9.28 第 8 行","width":2230,"length":6800,"quantity":1,"allowRotation":false,"note":"最多拼接 3 片；保留整片需求，未自动拆片"},
            {"id":9,"row":9,"name":"9.28 第 9 行","width":2403,"length":7440,"quantity":1,"allowRotation":false,"note":"最多拼接 3 片；保留整片需求，未自动拆片"}
        ]},
        {materialModel:"2#A3A-Cream", demands:[
            {"id":10,"row":10,"name":"9.28 第 10 行","width":2170,"length":3250,"quantity":2,"allowRotation":false,"note":"最多拼接 2 片；保留整片需求，未自动拆片"},
            {"id":11,"row":11,"name":"9.28 第 11 行","width":2170,"length":3570,"quantity":2,"allowRotation":false,"note":"最多拼接 2 片；保留整片需求，未自动拆片"},
            {"id":12,"row":12,"name":"9.28 第 12 行","width":2220,"length":1620,"quantity":1,"allowRotation":false,"note":""},
            {"id":13,"row":13,"name":"9.28 第 13 行","width":2715,"length":2930,"quantity":4,"allowRotation":false,"note":"最多拼接 2 片；保留整片需求，未自动拆片"},
            {"id":14,"row":14,"name":"9.28 第 14 行","width":2220,"length":2260,"quantity":2,"allowRotation":false,"note":""},
            {"id":15,"row":15,"name":"9.28 第 15 行","width":2220,"length":2260,"quantity":1,"allowRotation":false,"note":""},
            {"id":16,"row":16,"name":"9.28 第 16 行","width":2220,"length":2930,"quantity":1,"allowRotation":false,"note":"最多拼接 2 片；保留整片需求，未自动拆片"},
            {"id":17,"row":17,"name":"9.28 第 17 行","width":1603,"length":2260,"quantity":4,"allowRotation":false,"note":""},
            {"id":18,"row":18,"name":"9.28 第 18 行","width":1500,"length":3250,"quantity":2,"allowRotation":false,"note":"最多拼接 2 片；保留整片需求，未自动拆片"},
            {"id":19,"row":19,"name":"9.28 第 19 行","width":2640,"length":4470,"quantity":2,"allowRotation":false,"note":"最多拼接 2 片；保留整片需求，未自动拆片"},
            {"id":20,"row":20,"name":"9.28 第 20 行","width":2660,"length":2355,"quantity":2,"allowRotation":false,"note":""}
        ]},
        {materialModel:"2#A6A Dark sand taupe", demands:[
            {"id":21,"row":21,"name":"9.28 第 21 行","width":2220,"length":2260,"quantity":2,"allowRotation":false,"note":""},
            {"id":22,"row":22,"name":"9.28 第 22 行","width":1605,"length":1620,"quantity":1,"allowRotation":false,"note":""},
            {"id":23,"row":23,"name":"9.28 第 23 行","width":1605,"length":1620,"quantity":1,"allowRotation":false,"note":""},
            {"id":24,"row":24,"name":"9.28 第 24 行","width":2220,"length":1620,"quantity":1,"allowRotation":false,"note":""},
            {"id":25,"row":25,"name":"9.28 第 25 行","width":2460,"length":3890,"quantity":2,"allowRotation":false,"note":"最多拼接 2 片；保留整片需求，未自动拆片"}
        ]},
        {materialModel:"2#A7A Caramel", demands:[
            {"id":26,"row":26,"name":"9.28 第 26 行","width":2865,"length":2640,"quantity":1,"allowRotation":false,"note":""},
            {"id":27,"row":27,"name":"9.28 第 27 行","width":2865,"length":3230,"quantity":1,"allowRotation":false,"note":"最多拼接 2 片；保留整片需求，未自动拆片"},
            {"id":28,"row":28,"name":"9.28 第 28 行","width":2865,"length":2945,"quantity":2,"allowRotation":false,"note":"最多拼接 2 片；保留整片需求，未自动拆片"},
            {"id":29,"row":29,"name":"9.28 第 29 行","width":2865,"length":2920,"quantity":2,"allowRotation":false,"note":"最多拼接 2 片；保留整片需求，未自动拆片"},
            {"id":30,"row":30,"name":"9.28 第 30 行","width":2865,"length":5810,"quantity":2,"allowRotation":false,"note":"最多拼接 3 片；保留整片需求，未自动拆片"},
            {"id":31,"row":31,"name":"9.28 第 31 行","width":2865,"length":3245,"quantity":1,"allowRotation":false,"note":"最多拼接 2 片；保留整片需求，未自动拆片"}
        ]},
        {materialModel:"DREAM-A1 Off White（4#）", demands:[
            {"id":32,"row":32,"name":"9.28 第 32 行","width":2340,"length":1620,"quantity":2,"allowRotation":false,"note":""},
            {"id":33,"row":33,"name":"9.28 第 33 行","width":2340,"length":2580,"quantity":2,"allowRotation":false,"note":""},
            {"id":34,"row":34,"name":"9.28 第 34 行","width":2330,"length":2580,"quantity":2,"allowRotation":false,"note":""},
            {"id":35,"row":35,"name":"9.28 第 35 行","width":1740,"length":1940,"quantity":2,"allowRotation":false,"note":""},
            {"id":36,"row":36,"name":"9.28 第 36 行","width":1740,"length":1620,"quantity":2,"allowRotation":false,"note":""}
        ]},
        {materialModel:"DENVER-A16 Pearl（7#）", demands:[
            {"id":37,"row":37,"name":"9.28 第 37 行","width":2135,"length":1687.5,"quantity":2,"allowRotation":false,"note":""}
        ]},
        {materialModel:"TWILL-A2 Cream（1#）", demands:[
            {"id":38,"row":38,"name":"9.28 第 38 行","width":2705,"length":2930,"quantity":2,"allowRotation":false,"note":"最多拼接 2 片；保留整片需求，未自动拆片"},
            {"id":39,"row":39,"name":"9.28 第 39 行","width":2320,"length":2260,"quantity":2,"allowRotation":false,"note":""}
        ]},
        {materialModel:"DREAM-A2 Cream（4#）", demands:[
            {"id":40,"row":40,"name":"9.28 第 40 行","width":2785,"length":3875,"quantity":2,"allowRotation":false,"note":"最多拼接 2 片；保留整片需求，未自动拆片"},
            {"id":41,"row":41,"name":"9.28 第 41 行","width":2785,"length":3235,"quantity":2,"allowRotation":false,"note":"最多拼接 2 片；保留整片需求，未自动拆片"}
        ]},
        {materialModel:"DREAM-A3 Light Sand（4#）", demands:[
            {"id":42,"row":42,"name":"9.28 第 42 行","width":2580,"length":4515,"quantity":1,"allowRotation":false,"note":"最多拼接 2 片；保留整片需求，未自动拆片"},
            {"id":43,"row":43,"name":"9.28 第 43 行","width":2570,"length":4515,"quantity":1,"allowRotation":false,"note":"最多拼接 2 片；保留整片需求，未自动拆片"},
            {"id":44,"row":44,"name":"9.28 第 44 行","width":2535,"length":2930,"quantity":1,"allowRotation":false,"note":"最多拼接 2 片；保留整片需求，未自动拆片"},
            {"id":45,"row":45,"name":"9.28 第 45 行","width":1725,"length":2580,"quantity":2,"allowRotation":false,"note":""}
        ]},
        {materialModel:"DREAM-A4 SAND（4#）", demands:[
            {"id":46,"row":46,"name":"9.28 第 46 行","width":2420,"length":2260,"quantity":2,"allowRotation":false,"note":""},
            {"id":47,"row":47,"name":"9.28 第 47 行","width":2420,"length":3250,"quantity":2,"allowRotation":false,"note":"最多拼接 2 片；保留整片需求，未自动拆片"},
            {"id":48,"row":48,"name":"9.28 第 48 行","width":2350,"length":3890,"quantity":2,"allowRotation":false,"note":"最多拼接 2 片；保留整片需求，未自动拆片"}
        ]},
        {materialModel:"DREAM-A6 Taupe（4#）", demands:[
            {"id":49,"row":49,"name":"9.28 第 49 行","width":2286,"length":4530,"quantity":1,"allowRotation":false,"note":"最多拼接 2 片；保留整片需求，未自动拆片"},
            {"id":50,"row":50,"name":"9.28 第 50 行","width":2294,"length":2260,"quantity":1,"allowRotation":false,"note":""},
            {"id":51,"row":51,"name":"9.28 第 51 行","width":2286,"length":2260,"quantity":1,"allowRotation":false,"note":""},
            {"id":52,"row":52,"name":"9.28 第 52 行","width":2286,"length":2260,"quantity":1,"allowRotation":false,"note":""},
            {"id":53,"row":53,"name":"9.28 第 53 行","width":2287,"length":4530,"quantity":1,"allowRotation":false,"note":"最多拼接 2 片；保留整片需求，未自动拆片"},
            {"id":54,"row":54,"name":"9.28 第 54 行","width":2287,"length":4530,"quantity":1,"allowRotation":false,"note":"最多拼接 2 片；保留整片需求，未自动拆片"},
            {"id":55,"row":55,"name":"9.28 第 55 行","width":2287,"length":4530,"quantity":2,"allowRotation":false,"note":"最多拼接 2 片；保留整片需求，未自动拆片"}
        ]},
        {materialModel:"DREAM-A7 Caramel（4#）", demands:[
            {"id":56,"row":56,"name":"9.28 第 56 行","width":2065,"length":3655,"quantity":2,"allowRotation":false,"note":"最多拼接 2 片；保留整片需求，未自动拆片"},
            {"id":57,"row":57,"name":"9.28 第 57 行","width":2280,"length":2260,"quantity":6,"allowRotation":false,"note":""},
            {"id":58,"row":58,"name":"9.28 第 58 行","width":2280,"length":1620,"quantity":1,"allowRotation":false,"note":""},
            {"id":59,"row":59,"name":"9.28 第 59 行","width":2280,"length":1620,"quantity":1,"allowRotation":false,"note":""},
            {"id":60,"row":60,"name":"9.28 第 60 行","width":2280,"length":2260,"quantity":1,"allowRotation":false,"note":""},
            {"id":61,"row":61,"name":"9.28 第 61 行","width":2280,"length":2260,"quantity":1,"allowRotation":false,"note":""}
        ]},
        {materialModel:"TOUCH-A8 Latte（5#）", demands:[
            {"id":62,"row":62,"name":"9.28 第 62 行","width":2530,"length":3250,"quantity":2,"allowRotation":false,"note":"最多拼接 2 片；保留整片需求，未自动拆片"}
        ]},
        {materialModel:"DRAPE-A8 Latte（10#）", demands:[
            {"id":63,"row":63,"name":"9.28 第 63 行","width":2455,"length":6800,"quantity":1,"allowRotation":false,"note":"最多拼接 3 片；保留整片需求，未自动拆片"},
            {"id":64,"row":64,"name":"9.28 第 64 行","width":2455,"length":6800,"quantity":1,"allowRotation":false,"note":"最多拼接 3 片；保留整片需求，未自动拆片"},
            {"id":65,"row":65,"name":"9.28 第 65 行","width":2276,"length":2260,"quantity":1,"allowRotation":false,"note":""},
            {"id":66,"row":66,"name":"9.28 第 66 行","width":2273,"length":4530,"quantity":1,"allowRotation":false,"note":"最多拼接 2 片；保留整片需求，未自动拆片"},
            {"id":67,"row":67,"name":"9.28 第 67 行","width":2273,"length":4530,"quantity":1,"allowRotation":false,"note":"最多拼接 2 片；保留整片需求，未自动拆片"},
            {"id":68,"row":68,"name":"9.28 第 68 行","width":2283,"length":4530,"quantity":1,"allowRotation":false,"note":"最多拼接 2 片；保留整片需求，未自动拆片"},
            {"id":69,"row":69,"name":"9.28 第 69 行","width":2275,"length":4530,"quantity":1,"allowRotation":false,"note":"最多拼接 2 片；保留整片需求，未自动拆片"},
            {"id":70,"row":70,"name":"9.28 第 70 行","width":2284,"length":5840,"quantity":2,"allowRotation":false,"note":"最多拼接 3 片；保留整片需求，未自动拆片"}
        ]},
        {materialModel:"DENVER-A3 Light Sand（7#）", demands:[
            {"id":71,"row":71,"name":"9.28 第 71 行","width":2760,"length":4210,"quantity":1,"allowRotation":false,"note":"最多拼接 2 片；保留整片需求，未自动拆片"},
            {"id":72,"row":72,"name":"9.28 第 72 行","width":2760,"length":4210,"quantity":1,"allowRotation":false,"note":"最多拼接 2 片；保留整片需求，未自动拆片"},
            {"id":73,"row":73,"name":"9.28 第 73 行","width":2755,"length":3890,"quantity":2,"allowRotation":false,"note":"最多拼接 2 片；保留整片需求，未自动拆片"},
            {"id":74,"row":74,"name":"9.28 第 74 行","width":2513,"length":5170,"quantity":2,"allowRotation":false,"note":"最多拼接 2 片；保留整片需求，未自动拆片"}
        ]},
        {materialModel:"DREAM-A9 Amber（4#）", demands:[
            {"id":75,"row":75,"name":"9.28 第 75 行","width":2287,"length":2260,"quantity":1,"allowRotation":false,"note":""}
        ]},
        {materialModel:"DREAM-A11 Dystry Rose（4#）", demands:[
            {"id":76,"row":76,"name":"9.28 第 76 行","width":2289,"length":2260,"quantity":1,"allowRotation":false,"note":""},
            {"id":77,"row":77,"name":"9.28 第 77 行","width":2291,"length":2260,"quantity":1,"allowRotation":false,"note":""}
        ]},
        {materialModel:"DIVENE-SK13 Dysty blue（8#）", demands:[
            {"id":80,"row":80,"name":"9.28 第 80 行","width":1460,"length":2580,"quantity":2,"allowRotation":false,"note":""},
            {"id":81,"row":81,"name":"9.28 第 81 行","width":1460,"length":2580,"quantity":2,"allowRotation":false,"note":""},
            {"id":82,"row":82,"name":"9.28 第 82 行","width":1460,"length":2260,"quantity":2,"allowRotation":false,"note":""}
        ]},
        {materialModel:"Delicate-A12 Dusty Green（3#）", demands:[
            {"id":83,"row":83,"name":"9.28 第 83 行","width":2718,"length":3570,"quantity":2,"allowRotation":false,"note":"最多拼接 2 片；保留整片需求，未自动拆片"}
        ]},
        {materialModel:"Delicate-A13 Moss Green（3#）", demands:[
            {"id":84,"row":84,"name":"9.28 第 84 行","width":2635,"length":1940,"quantity":2,"allowRotation":false,"note":""}
        ]},
        {materialModel:"DREAM-A13 Moss Green（4#）", demands:[
            {"id":85,"row":85,"name":"9.28 第 85 行","width":2495,"length":5490,"quantity":1,"allowRotation":false,"note":"最多拼接 2 片；保留整片需求，未自动拆片"},
            {"id":86,"row":86,"name":"9.28 第 86 行","width":2665,"length":7760,"quantity":1,"allowRotation":false,"note":"最多拼接 3 片；保留整片需求，未自动拆片"},
            {"id":87,"row":87,"name":"9.28 第 87 行","width":2665,"length":7760,"quantity":1,"allowRotation":false,"note":"最多拼接 3 片；保留整片需求，未自动拆片"},
            {"id":88,"row":88,"name":"9.28 第 88 行","width":2665,"length":3890,"quantity":1,"allowRotation":false,"note":"最多拼接 2 片；保留整片需求，未自动拆片"},
            {"id":89,"row":89,"name":"9.28 第 89 行","width":2665,"length":5840,"quantity":2,"allowRotation":false,"note":"最多拼接 3 片；保留整片需求，未自动拆片"},
            {"id":90,"row":90,"name":"9.28 第 90 行","width":2665,"length":5490,"quantity":1,"allowRotation":false,"note":"最多拼接 2 片；保留整片需求，未自动拆片"},
            {"id":91,"row":91,"name":"9.28 第 91 行","width":2665,"length":6160,"quantity":1,"allowRotation":false,"note":"最多拼接 3 片；保留整片需求，未自动拆片"},
            {"id":92,"row":92,"name":"9.28 第 92 行","width":2665,"length":3250,"quantity":1,"allowRotation":false,"note":"最多拼接 2 片；保留整片需求，未自动拆片"},
            {"id":93,"row":93,"name":"9.28 第 93 行","width":2665,"length":7440,"quantity":1,"allowRotation":false,"note":"最多拼接 3 片；保留整片需求，未自动拆片"}
        ]},
        {materialModel:"DREAM-A18 Grey（4#）", demands:[
            {"id":94,"row":94,"name":"9.28 第 94 行","width":1875,"length":2965,"quantity":2,"allowRotation":false,"note":"最多拼接 2 片；保留整片需求，未自动拆片"}
        ]},
        {materialModel:"TOUCH-A18 Grey（5#）", demands:[
            {"id":95,"row":95,"name":"9.28 第 95 行","width":2270,"length":1940,"quantity":2,"allowRotation":false,"note":""},
            {"id":96,"row":96,"name":"9.28 第 96 行","width":2265,"length":2260,"quantity":1,"allowRotation":false,"note":""}
        ]},
        {materialModel:"11#5 Sand", demands:[
            {"id":97,"row":97,"name":"9.28 第 97 行","width":2595,"length":3555,"quantity":2,"allowRotation":false,"note":"最多拼接 2 片；保留整片需求，未自动拆片"},
            {"id":98,"row":98,"name":"9.28 第 98 行","width":1740,"length":2260,"quantity":2,"allowRotation":false,"note":""},
            {"id":99,"row":99,"name":"9.28 第 99 行","width":1710,"length":1620,"quantity":2,"allowRotation":false,"note":""}
        ]},
        {materialModel:"11#6 Khaki bown", demands:[
            {"id":100,"row":100,"name":"9.28 第 100 行","width":2286,"length":1940,"quantity":1,"allowRotation":false,"note":""},
            {"id":101,"row":101,"name":"9.28 第 101 行","width":2286,"length":1940,"quantity":1,"allowRotation":false,"note":""},
            {"id":102,"row":102,"name":"9.28 第 102 行","width":2527,"length":3250,"quantity":4,"allowRotation":false,"note":"最多拼接 2 片；保留整片需求，未自动拆片"},
            {"id":103,"row":103,"name":"9.28 第 103 行","width":2637,"length":2930,"quantity":1,"allowRotation":false,"note":"最多拼接 2 片；保留整片需求，未自动拆片"},
            {"id":104,"row":104,"name":"9.28 第 104 行","width":2637,"length":2930,"quantity":1,"allowRotation":false,"note":"最多拼接 2 片；保留整片需求，未自动拆片"},
            {"id":105,"row":105,"name":"9.28 第 105 行","width":2278,"length":2260,"quantity":1,"allowRotation":false,"note":""},
            {"id":106,"row":106,"name":"9.28 第 106 行","width":2523,"length":5170,"quantity":1,"allowRotation":false,"note":"最多拼接 2 片；保留整片需求，未自动拆片"}
        ]},
        {materialModel:"11#22 Dark blue", demands:[
            {"id":107,"row":107,"name":"9.28 第 107 行","width":2520,"length":6480,"quantity":1,"allowRotation":false,"note":"最多拼接 3 片；保留整片需求，未自动拆片"}
        ]}
    ]
};
