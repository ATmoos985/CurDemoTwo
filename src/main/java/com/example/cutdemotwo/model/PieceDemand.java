package com.example.cutdemotwo.model;

public class PieceDemand {
    private Integer id = 0;
    private String name;
    private double width;
    private double length;
    private int demand = 1;
    private Boolean allowRotation = false;

    public PieceDemand() {}

    public PieceDemand(int id, String name, double width, double length, int demand, boolean allowRotation) {
        this.id = id;
        this.name = name;
        this.width = width;
        this.length = length;
        this.demand = demand;
        this.allowRotation = allowRotation;
    }

    public int getId() { return id != null ? id : 0; }
    public void setId(Integer id) { this.id = id; }

    public String getName() { return name; }
    public void setName(String name) { this.name = name; }

    public double getWidth() { return width; }
    public void setWidth(double width) { this.width = width; }

    public double getLength() { return length; }
    public void setLength(double length) { this.length = length; }

    public int getDemand() { return demand; }
    public void setDemand(int demand) { this.demand = demand; }

    public boolean isAllowRotation() { return Boolean.TRUE.equals(allowRotation); }
    public void setAllowRotation(Boolean allowRotation) { this.allowRotation = allowRotation; }
}
