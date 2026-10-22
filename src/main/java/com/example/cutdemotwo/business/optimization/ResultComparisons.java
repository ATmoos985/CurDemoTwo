package com.example.cutdemotwo.business.optimization;

import com.example.cutdemotwo.contracts.jobs.*;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;
import tools.jackson.databind.json.JsonMapper;
import java.util.*;

/** Comparison policy lives in the application layer so REST and MCP share it. */
public final class ResultComparisons {
    private static final JsonMapper JSON=JsonMapper.builder().build();
    private ResultComparisons() {}
    public static ResultComparison compare(OptimizationRequest leftInput,OptimizationResult left,
            OptimizationRequest rightInput,OptimizationResult right) {
        var differences=new ArrayList<String>();
        if(!Objects.equals(leftInput.problemType(),rightInput.problemType()))differences.add("problemType");
        if(!Objects.equals(leftInput.schemaVersion(),rightInput.schemaVersion()))differences.add("schemaVersion");
        if(!Objects.equals(leftInput.requireComplete(),rightInput.requireComplete()))differences.add("requireComplete");
        var a=constraints(leftInput);var b=constraints(rightInput);
        var fields=new TreeSet<String>();a.properties().forEach(e->fields.add(e.getKey()));b.properties().forEach(e->fields.add(e.getKey()));
        for(String field:fields)if(!Objects.equals(a.get(field),b.get(field)))differences.add("problem."+field);
        boolean same=differences.isEmpty();
        var leftMetrics=new LinkedHashMap<String,OptimizationResult.Metric>();left.metrics().forEach(m->leftMetrics.put(m.name(),m));
        var rightMetrics=new LinkedHashMap<String,OptimizationResult.Metric>();right.metrics().forEach(m->rightMetrics.put(m.name(),m));
        var names=new LinkedHashSet<>(leftMetrics.keySet());names.addAll(rightMetrics.keySet());
        var deltas=new ArrayList<ResultComparison.MetricDelta>();
        for(String name:names){
            var l=leftMetrics.get(name);var r=rightMetrics.get(name);
            boolean aligned=l!=null&&r!=null&&Objects.equals(l.unit(),r.unit())&&Objects.equals(l.basis(),r.basis())&&Objects.equals(l.version(),r.version());
            String status=!same?"DIFFERENT_CONSTRAINTS":!aligned?"INCOMPATIBLE_METRIC":"COMPARABLE";
            deltas.add(new ResultComparison.MetricDelta(name,l,r,
                    "COMPARABLE".equals(status)?r.value()-l.value():null,status));
        }
        return new ResultComparison("1",left.id(),right.id(),same,List.copyOf(differences),left.fulfillmentStatus(),right.fulfillmentStatus(),
                left.meetsRequirement(),right.meetsRequirement(),List.copyOf(deltas));
    }
    private static JsonNode constraints(OptimizationRequest input){
        ObjectNode problem=JSON.valueToTree(input.problem());
        problem.remove("engine");problem.remove("timeLimitSeconds");
        if("SLITTING_1D".equals(input.problemType()))problem.remove("profile");
        else if(problem.get("process") instanceof ObjectNode process)process.remove("objective");
        return problem;
    }
}
