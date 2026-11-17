package com.example.cutdemotwo.contracts.jobs;

import com.example.cutdemotwo.contracts.nesting.NestingProblem;

/** v2 job envelope; nesting-v1 is the explicitly supported geometry profile. */
@tools.jackson.databind.annotation.JsonDeserialize(using = OptimizationRequest.Decoder.class)
public record OptimizationRequest(String schemaVersion, String problemType, String clientRequestId,
                                  OptimizationProblem problem, Boolean allowFallback, Boolean requireComplete,
                                  @com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL)
                                  Strategy strategy) {
    public OptimizationRequest(String schemaVersion, String problemType, String clientRequestId,
                               OptimizationProblem problem, Boolean allowFallback, Boolean requireComplete) {
        this(schemaVersion, problemType, clientRequestId, problem, allowFallback, requireComplete, null);
    }
    public NestingProblem nestingProblem() { return (NestingProblem) problem; }
    public com.example.cutdemotwo.contracts.slitting.SlittingProblem slittingProblem() {
        return (com.example.cutdemotwo.contracts.slitting.SlittingProblem) problem;
    }
    // Deserialization-only discriminator: serialization stays byte-compatible with old archives/hashes.
    public static final class Decoder extends tools.jackson.databind.ValueDeserializer<OptimizationRequest> {
        @Override public OptimizationRequest deserialize(tools.jackson.core.JsonParser parser,
                tools.jackson.databind.DeserializationContext context) {
            var wire=context.readValue(parser, Wire.class);
            Class<? extends OptimizationProblem> type="SLITTING_1D".equals(wire.problemType())
                    ? com.example.cutdemotwo.contracts.slitting.SlittingProblem.class : NestingProblem.class;
            var problem=wire.problem()==null || wire.problem().isNull()?null:context.readTreeAsValue(wire.problem(),type);
            return new OptimizationRequest(wire.schemaVersion(),wire.problemType(),wire.clientRequestId(),problem,
                    wire.allowFallback(),wire.requireComplete(),wire.strategy());
        }
    }
    private record Wire(String schemaVersion,String problemType,String clientRequestId,
                        tools.jackson.databind.JsonNode problem,Boolean allowFallback,Boolean requireComplete,Strategy strategy) {}
    /** Source-local pose only. The solver reconstructs every outline from the request's demands. */
    public record InitialPlacement(Integer demandId, Double x, Double y, Integer rotationDegrees) {}
    public record Strategy(String id, String version, int maxTrials,
                           @com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL)
                           java.util.Map<Integer, Integer> gapFillLimits,
                           @com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL)
                           java.util.List<InitialPlacement> initialPlacements) {
        public Strategy {
            if (gapFillLimits != null)
                gapFillLimits = java.util.Collections.unmodifiableSortedMap(new java.util.TreeMap<>(gapFillLimits));
            if (initialPlacements != null)
                initialPlacements = java.util.Collections.unmodifiableList(new java.util.ArrayList<>(initialPlacements));
        }
        public Strategy(String id, String version, int maxTrials, java.util.Map<Integer,Integer> gapFillLimits) {
            this(id, version, maxTrials, gapFillLimits, null);
        }
        public Strategy(String id, String version, int maxTrials) {
            this(id, version, maxTrials, null);
        }
    }
}
