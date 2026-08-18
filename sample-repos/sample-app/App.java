package com.example.legacy;

/**
 * Sample legacy Java application for code modernization assessment testing.
 */
public class App {
    public static void main(String[] args) {
        System.out.println("Starting legacy PetClinic service v1.0...");
        // Legacy database initialization
        initDatabaseConnection();
    }

    private static void initDatabaseConnection() {
        System.out.println("Connecting to JDBC data source...");
    }
}
