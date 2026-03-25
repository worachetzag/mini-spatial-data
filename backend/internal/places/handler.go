package places

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/labstack/echo/v4"
	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/bson/primitive"
	"go.mongodb.org/mongo-driver/mongo"
)

type Handler struct {
	repo *Repository
}

type UpdatePlaceInput struct {
	Geometry   *Geometry      `json:"geometry"`
	Properties map[string]any `json:"properties"`
	Type       *string        `json:"type"`
}

const (
	defaultPage  int64 = 1
	defaultLimit int64 = 10
	maxLimit     int64 = 100
)

func NewHandler(repo *Repository) *Handler {
	return &Handler{repo: repo}
}

func (h *Handler) List(c echo.Context) error {
	page := defaultPage
	if raw := strings.TrimSpace(c.QueryParam("page")); raw != "" {
		v, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || v < 1 {
			return c.JSON(http.StatusBadRequest, map[string]string{
				"error": "page must be a positive integer",
			})
		}
		page = v
	}

	limit := defaultLimit
	if raw := strings.TrimSpace(c.QueryParam("limit")); raw != "" {
		v, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || v < 1 {
			return c.JSON(http.StatusBadRequest, map[string]string{
				"error": "limit must be a positive integer",
			})
		}
		if v > maxLimit {
			v = maxLimit
		}
		limit = v
	}

	ctx, cancel := context.WithTimeout(c.Request().Context(), 5*time.Second)
	defer cancel()

	places, total, err := h.repo.List(ctx, page, limit)
	if err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]string{
			"error": "failed to load places",
		})
	}

	totalPages := int64(0)
	if total > 0 {
		totalPages = (total + limit - 1) / limit
	}

	return c.JSON(http.StatusOK, map[string]any{
		"count":      len(places),
		"data":       places,
		"page":       page,
		"limit":      limit,
		"total":      total,
		"totalPages": totalPages,
	})
}

func (h *Handler) Create(c echo.Context) error {
	var input Place
	if err := c.Bind(&input); err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{
			"error": "invalid request body",
		})
	}

	input.Type = strings.TrimSpace(input.Type)
	input.Geometry.Type = strings.TrimSpace(input.Geometry.Type)
	if input.Type == "" {
		input.Type = "Feature"
	}

	if input.Type != "Feature" {
		return c.JSON(http.StatusBadRequest, map[string]string{
			"error": "type must be Feature",
		})
	}

	if input.Geometry.Type != "Point" || len(input.Geometry.Coordinates) != 2 {
		return c.JSON(http.StatusBadRequest, map[string]string{
			"error": "geometry must be Point with [lng, lat]",
		})
	}

	if input.Properties == nil {
		input.Properties = map[string]any{}
	}

	ctx, cancel := context.WithTimeout(c.Request().Context(), 5*time.Second)
	defer cancel()

	id, err := h.repo.Create(ctx, &input)
	if err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]string{
			"error": "failed to create place",
		})
	}
	input.ID = id

	return c.JSON(http.StatusCreated, input)
}

func (h *Handler) GetByID(c echo.Context) error {
	idHex := c.Param("id")
	id, err := primitive.ObjectIDFromHex(idHex)
	if err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{
			"error": "invalid place id",
		})
	}

	ctx, cancel := context.WithTimeout(c.Request().Context(), 5*time.Second)
	defer cancel()

	place, err := h.repo.GetByID(ctx, id)
	if err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			return c.JSON(http.StatusNotFound, map[string]string{
				"error": "place not found",
			})
		}

		return c.JSON(http.StatusInternalServerError, map[string]string{
			"error": "failed to load place",
		})
	}

	return c.JSON(http.StatusOK, place)
}

func (h *Handler) DeleteByID(c echo.Context) error {
	idHex := c.Param("id")
	id, err := primitive.ObjectIDFromHex(idHex)
	if err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{
			"error": "invalid place id",
		})
	}

	ctx, cancel := context.WithTimeout(c.Request().Context(), 5*time.Second)
	defer cancel()

	deleted, err := h.repo.DeleteByID(ctx, id)
	if err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]string{
			"error": "failed to delete place",
		})
	}

	if !deleted {
		return c.JSON(http.StatusNotFound, map[string]string{
			"error": "place not found",
		})
	}

	return c.JSON(http.StatusOK, map[string]string{
		"message": "place deleted",
	})
}

func (h *Handler) UpdateByID(c echo.Context) error {
	idHex := c.Param("id")
	id, err := primitive.ObjectIDFromHex(idHex)
	if err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{
			"error": "invalid place id",
		})
	}

	var input UpdatePlaceInput
	if err := c.Bind(&input); err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{
			"error": "invalid request body",
		})
	}

	setFields := bson.M{}
	if input.Type != nil {
		t := strings.TrimSpace(*input.Type)
		if t == "" {
			t = "Feature"
		}
		if t != "Feature" {
			return c.JSON(http.StatusBadRequest, map[string]string{
				"error": "type must be Feature",
			})
		}
		setFields["type"] = t
	}

	if input.Geometry != nil {
		input.Geometry.Type = strings.TrimSpace(input.Geometry.Type)
		if input.Geometry.Type != "Point" || len(input.Geometry.Coordinates) != 2 {
			return c.JSON(http.StatusBadRequest, map[string]string{
				"error": "geometry must be Point with [lng, lat]",
			})
		}
		setFields["geometry"] = input.Geometry
	}

	if input.Properties != nil {
		setFields["properties"] = input.Properties
	}

	if len(setFields) == 0 {
		return c.JSON(http.StatusBadRequest, map[string]string{
			"error": "no updatable fields provided",
		})
	}

	ctx, cancel := context.WithTimeout(c.Request().Context(), 5*time.Second)
	defer cancel()

	updated, err := h.repo.UpdateByID(ctx, id, setFields)
	if err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]string{
			"error": "failed to update place",
		})
	}
	if !updated {
		return c.JSON(http.StatusNotFound, map[string]string{
			"error": "place not found",
		})
	}

	place, err := h.repo.GetByID(ctx, id)
	if err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]string{
			"error": "updated but failed to reload place",
		})
	}

	return c.JSON(http.StatusOK, place)
}
