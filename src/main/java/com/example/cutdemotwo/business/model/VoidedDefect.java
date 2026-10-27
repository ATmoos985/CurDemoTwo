package com.example.cutdemotwo.business.model;

import com.example.cutdemotwo.contracts.geometry.Defect;

/** 已作废的疵点：保留原记录、原因与时间，不再参与排料避让。 */
public record VoidedDefect(Defect defect, String reason, String voidedAt, String actor) {}
