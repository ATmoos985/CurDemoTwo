package com.example.cutdemotwo.service.solver;

import com.example.cutdemotwo.model.SolveRequest;
import com.example.cutdemotwo.model.SolveResponse;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 排料求解策略工厂 (Strategy Factory)
 * 动态分发求解请求，支持多算法引擎插件式热插拔
 */
@Service
public class SolverFactory {

    private final Map<String, ICutSolverEngine> engineMap = new ConcurrentHashMap<>();

    @Autowired
    public SolverFactory(List<ICutSolverEngine> engines) {
        for (ICutSolverEngine engine : engines) {
            engineMap.put(engine.getEngineType().toLowerCase(), engine);
        }
    }

    public ICutSolverEngine getEngine(String solverType) {
        if (solverType == null || solverType.trim().isEmpty()) {
            solverType = "packingsolver";
        }
        ICutSolverEngine engine = engineMap.get(solverType.toLowerCase());
        if (engine == null) {
            engine = engineMap.get("packingsolver");
        }
        return engine;
    }

    public SolveResponse solve(SolveRequest request) {
        ICutSolverEngine engine = getEngine(request.getSolver());
        if (engine == null) {
            SolveResponse err = new SolveResponse();
            err.setSuccess(false);
            err.setMessage("系统未找到支持的排料引擎: " + request.getSolver());
            return err;
        }
        return engine.solve(request);
    }
}
