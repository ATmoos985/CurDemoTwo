package com.example.cutdemotwo.contracts.nesting;

import java.util.List;

public record EngineCapabilities(String id, String version, List<String> shapes, List<String> modes,
                                 List<String> objectives, double coordinateResolutionMm, boolean available) {}
