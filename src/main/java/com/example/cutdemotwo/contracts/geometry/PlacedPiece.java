package com.example.cutdemotwo.contracts.geometry;

public class PlacedPiece {
    private int id;
    private String name;
    private com.example.cutdemotwo.contracts.nesting.NestingProblem.Shape shape;
    private int rotationDegrees;
    public com.example.cutdemotwo.contracts.nesting.NestingProblem.Shape getShape() { return shape; }
    public void setShape(com.example.cutdemotwo.contracts.nesting.NestingProblem.Shape value) { shape = value; }
    public int getRotationDegrees() { return rotationDegrees; }
    public void setRotationDegrees(int value) { rotationDegrees = value; }
    public double areaMm2() { return shape == null ? w * l : shape.areaMm2(); }
    private double x;
    private double y;
    private double w;
    private double l;
    private boolean rotated;
    private Integer demandId;

    public PlacedPiece() {}

    public PlacedPiece(int id, String name, double x, double y, double w, double l, boolean rotated) {
        this(id, name, x, y, w, l, rotated, null);
    }

    public PlacedPiece(int id, String name, double x, double y, double w, double l, boolean rotated, Integer demandId) {
        this.id = id;
        this.name = name;
        this.x = x;
        this.y = y;
        this.w = w;
        this.l = l;
        this.rotated = rotated;
        this.demandId = demandId;
    }

    public int getId() { return id; }
    public void setId(int id) { this.id = id; }

    public String getName() { return name; }
    public void setName(String name) { this.name = name; }

    public double getX() { return x; }
    public void setX(double x) { this.x = x; }

    public double getY() { return y; }
    public void setY(double y) { this.y = y; }

    public double getW() { return w; }
    public void setW(double w) { this.w = w; }

    public double getL() { return l; }
    public void setL(double l) { this.l = l; }

    public boolean isRotated() { return rotated; }
    public void setRotated(boolean rotated) { this.rotated = rotated; }

    public Integer getDemandId() { return demandId; }
    public void setDemandId(Integer demandId) { this.demandId = demandId; }
}
