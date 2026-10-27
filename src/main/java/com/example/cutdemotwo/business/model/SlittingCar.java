package com.example.cutdemotwo.business.model;

import com.example.cutdemotwo.contracts.geometry.PlacedPiece;

import java.util.List;

/** 一维分切的一车：母卷上的定长工位 + 按分切组合排好的条（件）。后端只校验并保存，不重新求解。 */
public record SlittingCar(SolveRequest request, List<PlacedPiece> pieces) {}
