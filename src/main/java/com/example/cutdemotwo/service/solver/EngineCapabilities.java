package com.example.cutdemotwo.service.solver;

import java.util.List;

public record EngineCapabilities(String id, String version, List<String> shapes, List<String> modes,
                                 List<String> objectives, double coordinateResolutionMm, boolean available) {}
