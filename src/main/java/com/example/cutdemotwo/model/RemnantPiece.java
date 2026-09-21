package com.example.cutdemotwo.model;

public class RemnantPiece {
    private String id;
    private String status;
    private double x;
    private double y;
    private double w;
    private double l;
    private double area;
    private boolean hasDefect;

    public RemnantPiece() {}

    public RemnantPiece(String id, String status, double x, double y, double w, double l, double area, boolean hasDefect) {
        this.id = id;
        this.status = status;
        this.x = x;
        this.y = y;
        this.w = w;
        this.l = l;
        this.area = area;
        this.hasDefect = hasDefect;
    }

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }

    public String getStatus() { return status; }
    public void setStatus(String status) { this.status = status; }

    public double getX() { return x; }
    public void setX(double x) { this.x = x; }

    public double getY() { return y; }
    public void setY(double y) { this.y = y; }

    public double getW() { return w; }
    public void setW(double w) { this.w = w; }

    public double getL() { return l; }
    public void setL(double l) { this.l = l; }

    public double getArea() { return area; }
    public void setArea(double area) { this.area = area; }

    public boolean isHasDefect() { return hasDefect; }
    public void setHasDefect(boolean hasDefect) { this.hasDefect = hasDefect; }
}
