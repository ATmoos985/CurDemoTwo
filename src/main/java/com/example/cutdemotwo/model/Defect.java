package com.example.cutdemotwo.model;

public class Defect {
    private Integer id = 0;
    private double x;
    private double y;
    private double w;
    private double h;
    private double margin = 20.0;

    public Defect() {}

    public Defect(int id, double x, double y, double w, double h, double margin) {
        this.id = id;
        this.x = x;
        this.y = y;
        this.w = w;
        this.h = h;
        this.margin = margin;
    }

    public int getId() { return id != null ? id : 0; }
    public void setId(Integer id) { this.id = id; }

    public double getX() { return x; }
    public void setX(double x) { this.x = x; }

    public double getY() { return y; }
    public void setY(double y) { this.y = y; }

    public double getW() { return w; }
    public void setW(double w) { this.w = w; }

    public double getH() { return h; }
    public void setH(double h) { this.h = h; }

    public double getMargin() { return margin; }
    public void setMargin(double margin) { this.margin = margin; }

    public double getSafeX() { return Math.max(0, x - margin); }
    public double getSafeY() { return Math.max(0, y - margin); }
    public double getSafeW() { return w + 2 * margin; }
    public double getSafeH() { return h + 2 * margin; }
}
