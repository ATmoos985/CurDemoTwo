package com.example.cutdemotwo.service;

import com.example.cutdemotwo.model.*;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.List;

@Service
public class ScenarioOneService {

    public SolveResponse getScenario(int scenarioId) {
        switch (scenarioId) {
            case 1:
                return getTableOneLShape();
            case 2:
                return getWidthAdaptation(true);
            case 3:
                return getShortRemnantReuse();
            default:
                return getTableOneLShape();
        }
    }

    public SolveResponse getTableOneLShape() {
        SolveResponse res = new SolveResponse();
        res.setSuccess(true);
        res.setEngine("Word 表1 精确正交拆解引擎");
        res.setRollW(2000.0);
        res.setRollL(4000.0);

        List<PlacedPiece> pieces = new ArrayList<>();
        pieces.add(new PlacedPiece(1, "标准成品", 0, 0, 1500, 3000, false));
        res.setPieces(pieces);

        List<RemnantPiece> remnants = new ArrayList<>();
        remnants.add(new RemnantPiece("REM-01", "右侧可用料头", 1500, 0, 500, 4000, 2.0, false));
        remnants.add(new RemnantPiece("REM-02", "左侧末端料头", 0, 3000, 1500, 1000, 1.5, false));
        res.setRemnants(remnants);

        List<CutStep> cuts = new ArrayList<>();
        cuts.add(new CutStep(1, "纵切", 1500, 0, 4000, "在宽度1500mm处纵切到底，切出右侧料头(0.5m×4m)"));
        cuts.add(new CutStep(2, "横切", 3000, 0, 1500, "在展开3000mm处横切切断，产出成品并切出末端料头(1.5m×1m)"));
        res.setCuts(cuts);

        res.setDeductLen(4000.0);
        res.setPieceArea(4.5);
        res.setRemArea(3.5);
        res.setWasteArea(0.0);
        res.setTotalArea(8.0);
        return res;
    }

    public SolveResponse getWidthAdaptation(boolean allowLongitudinal) {
        SolveResponse res = new SolveResponse();
        res.setSuccess(true);
        res.setRollW(2000.0);
        res.setRollL(4000.0);

        List<Defect> defects = new ArrayList<>();
        defects.add(new Defect(1, 200, 1500, 150, 600, 50));
        res.setDefects(defects);

        if (allowLongitudinal) {
            res.setEngine("带疵改宽排料引擎 (纵切许可)");
            List<PlacedPiece> pieces = new ArrayList<>();
            pieces.add(new PlacedPiece(1, "改宽成品", 500, 0, 1500, 4000, false));
            res.setPieces(pieces);

            List<RemnantPiece> remnants = new ArrayList<>();
            remnants.add(new RemnantPiece("REM-DEF-01", "左侧带疵料头", 0, 0, 500, 4000, 2.0, true));
            res.setRemnants(remnants);

            List<CutStep> cuts = new ArrayList<>();
            cuts.add(new CutStep(1, "纵切", 500, 0, 4000, "在宽度500mm处一刀纵切到底，完好产出1.5m×4m成品，保留左侧带疵料头"));
            res.setCuts(cuts);

            res.setDeductLen(4000.0);
            res.setPieceArea(6.0);
            res.setRemArea(2.0);
            res.setWasteArea(0.0);
            res.setTotalArea(8.0);
        } else {
            res.setEngine("安全拦截器 (设备仅能横切，禁止改宽)");
            res.setSuccess(false);
            res.setMessage("设备不支持纵切，禁止下发改宽方案，避免损坏原料！");
            res.setTotalArea(8.0);
        }
        return res;
    }

    public SolveResponse getShortRemnantReuse() {
        SolveResponse res = new SolveResponse();
        res.setSuccess(true);
        res.setEngine("料头优先匹配调度器 (母卷0消耗)");
        res.setRollW(2000.0);
        res.setRollL(1600.0);

        List<PlacedPiece> pieces = new ArrayList<>();
        pieces.add(new PlacedPiece(1, "新订单成品 (领用料头)", 0, 0, 2000, 1000, false));
        res.setPieces(pieces);

        List<RemnantPiece> remnants = new ArrayList<>();
        remnants.add(new RemnantPiece("REM-SHORT-SUB", "可用子料头", 0, 1000, 2000, 600, 1.2, false));
        res.setRemnants(remnants);

        List<CutStep> cuts = new ArrayList<>();
        cuts.add(new CutStep(1, "横切", 1000, 0, 2000, "从原入库料头 REM-SHORT-01 截取1m成品，余下0.6m重新登记入库"));
        res.setCuts(cuts);

        res.setDeductLen(0.0); // 母卷扣料为0
        res.setPieceArea(2.0);
        res.setRemArea(1.2);
        res.setWasteArea(0.0);
        res.setTotalArea(3.2);
        return res;
    }
}
