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
    public record Strategy(String id, String version, int maxTrials) {}
}
