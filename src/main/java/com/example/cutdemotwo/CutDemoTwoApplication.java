package com.example.cutdemotwo;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

// Our storage configuration owns the pool. DevTools' optional JDBC pool wrapper
// assumes Boot JDBC auto-configuration, which this explicit storage setup does not use.
@SpringBootApplication(excludeName = "org.springframework.boot.devtools.autoconfigure.DevToolsDataSourceAutoConfiguration")
public class CutDemoTwoApplication {

    public static void main(String[] args) {
        SpringApplication.run(CutDemoTwoApplication.class, args);
    }

}
