package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/home/mini-spatial-data/backend/internal/places"
	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"
)

func mongoURI() string {
	if u := os.Getenv("MONGODB_URI"); u != "" {
		return u
	}
	return "mongodb://localhost:27017"
}

func mongoDBName() string {
	if n := os.Getenv("MONGODB_DB"); n != "" {
		return n
	}
	return "spatial_data"
}

func corsOrigins() []string {
	if raw := os.Getenv("CORS_ALLOW_ORIGINS"); raw != "" {
		parts := strings.Split(raw, ",")
		origins := make([]string, 0, len(parts))
		for _, p := range parts {
			if trimmed := strings.TrimSpace(p); trimmed != "" {
				origins = append(origins, trimmed)
			}
		}
		if len(origins) > 0 {
			return origins
		}
	}

	// Safe default for demo deployments.
	return []string{"*"}
}

func main() {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	client, err := mongo.Connect(ctx, options.Client().ApplyURI(mongoURI()))
	if err != nil {
		log.Fatalf("mongo connect: %v", err)
	}
	defer func() {
		_ = client.Disconnect(context.Background())
	}()

	pingCtx, pingCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer pingCancel()
	if err := client.Ping(pingCtx, nil); err != nil {
		log.Fatalf("mongo ping: %v", err)
	}

	e := echo.New()
	e.HideBanner = true
	e.Use(middleware.Logger())
	e.Use(middleware.Recover())
	e.Use(middleware.CORSWithConfig(middleware.CORSConfig{
		AllowOrigins: corsOrigins(),
		AllowMethods: []string{http.MethodGet, http.MethodPost, http.MethodPatch, http.MethodDelete, http.MethodOptions},
		AllowHeaders: []string{echo.HeaderOrigin, echo.HeaderContentType, echo.HeaderAccept},
	}))

	placeRepo := places.NewRepository(client.Database(mongoDBName()))
	placeHandler := places.NewHandler(placeRepo)

	e.GET("/health", func(c echo.Context) error {
		return c.JSON(http.StatusOK, map[string]string{
			"status": "ok",
			"mongo":  "up",
		})
	})
	e.GET("/api/places", placeHandler.List)
	e.GET("/api/places/:id", placeHandler.GetByID)
	e.POST("/api/places", placeHandler.Create)
	e.PATCH("/api/places/:id", placeHandler.UpdateByID)
	e.DELETE("/api/places/:id", placeHandler.DeleteByID)

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	e.Logger.Fatal(e.Start(":" + port))
}
