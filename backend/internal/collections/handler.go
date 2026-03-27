package collections

import (
	"context"
	"errors"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/home/mini-spatial-data/backend/internal/places"
	"github.com/labstack/echo/v4"
	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/bson/primitive"
	"go.mongodb.org/mongo-driver/mongo"
)

var hexColor = regexp.MustCompile(`^#[0-9A-Fa-f]{6}$`)

type Handler struct {
	repo       *Repository
	placesRepo *places.Repository
}

func NewHandler(repo *Repository, placesRepo *places.Repository) *Handler {
	return &Handler{repo: repo, placesRepo: placesRepo}
}

type createInput struct {
	Name  string `json:"name"`
	Color string `json:"color"`
}

type updateInput struct {
	Name  *string `json:"name"`
	Color *string `json:"color"`
}

func normalizeColor(raw string) string {
	s := strings.TrimSpace(raw)
	if s == "" {
		return "#64748b"
	}
	if !strings.HasPrefix(s, "#") {
		s = "#" + s
	}
	if !hexColor.MatchString(s) {
		return ""
	}
	return strings.ToLower(s)
}

func (h *Handler) List(c echo.Context) error {
	ctx, cancel := context.WithTimeout(c.Request().Context(), 5*time.Second)
	defer cancel()

	list, err := h.repo.List(ctx)
	if err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]string{"error": "failed to list collections"})
	}
	return c.JSON(http.StatusOK, map[string]any{"data": list})
}

func (h *Handler) Create(c echo.Context) error {
	var in createInput
	if err := c.Bind(&in); err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "invalid request body"})
	}
	name := NormalizeName(in.Name)
	if name == "" {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "name is required"})
	}
	color := normalizeColor(in.Color)
	if color == "" {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "color must be #RRGGBB hex"})
	}

	ctx, cancel := context.WithTimeout(c.Request().Context(), 5*time.Second)
	defer cancel()

	existing, err := h.repo.FindByName(ctx, name)
	if err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]string{"error": "failed to check name"})
	}
	if existing != nil {
		return c.JSON(http.StatusConflict, map[string]string{"error": "collection name already exists"})
	}

	doc := &Collection{Name: name, Color: color}
	id, err := h.repo.Create(ctx, doc)
	if err != nil {
		if mongo.IsDuplicateKeyError(err) {
			return c.JSON(http.StatusConflict, map[string]string{"error": "collection name already exists"})
		}
		return c.JSON(http.StatusInternalServerError, map[string]string{"error": "failed to create collection"})
	}
	doc.ID = id
	return c.JSON(http.StatusCreated, doc)
}

func (h *Handler) Update(c echo.Context) error {
	idHex := c.Param("id")
	id, err := primitive.ObjectIDFromHex(idHex)
	if err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "invalid collection id"})
	}

	var in updateInput
	if err := c.Bind(&in); err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "invalid request body"})
	}

	ctx, cancel := context.WithTimeout(c.Request().Context(), 8*time.Second)
	defer cancel()

	cur, err := h.repo.GetByID(ctx, id)
	if err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			return c.JSON(http.StatusNotFound, map[string]string{"error": "collection not found"})
		}
		return c.JSON(http.StatusInternalServerError, map[string]string{"error": "failed to load collection"})
	}

	oldName := cur.Name
	set := bson.M{}

	if in.Color != nil {
		col := normalizeColor(*in.Color)
		if col == "" {
			return c.JSON(http.StatusBadRequest, map[string]string{"error": "color must be #RRGGBB hex"})
		}
		set["color"] = col
	}

	if in.Name != nil {
		newName := NormalizeName(*in.Name)
		if newName == "" {
			return c.JSON(http.StatusBadRequest, map[string]string{"error": "name is required"})
		}
		if newName != oldName {
			other, err := h.repo.FindByName(ctx, newName)
			if err != nil {
				return c.JSON(http.StatusInternalServerError, map[string]string{"error": "failed to check name"})
			}
			if other != nil && other.ID != cur.ID {
				return c.JSON(http.StatusConflict, map[string]string{"error": "collection name already exists"})
			}
			set["name"] = newName
		}
	}

	if len(set) == 0 {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "no updatable fields"})
	}

	if newName, ok := set["name"].(string); ok && newName != oldName {
		if _, err := h.placesRepo.RenameCollectionProperty(ctx, oldName, newName); err != nil {
			return c.JSON(http.StatusInternalServerError, map[string]string{"error": "failed to rename collection on places"})
		}
	}

	ok, err := h.repo.UpdateByID(ctx, id, set)
	if err != nil {
		if mongo.IsDuplicateKeyError(err) {
			return c.JSON(http.StatusConflict, map[string]string{"error": "collection name already exists"})
		}
		return c.JSON(http.StatusInternalServerError, map[string]string{"error": "failed to update collection"})
	}
	if !ok {
		return c.JSON(http.StatusNotFound, map[string]string{"error": "collection not found"})
	}

	updated, err := h.repo.GetByID(ctx, id)
	if err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]string{"error": "updated but failed to reload"})
	}
	return c.JSON(http.StatusOK, updated)
}

func (h *Handler) Delete(c echo.Context) error {
	idHex := c.Param("id")
	id, err := primitive.ObjectIDFromHex(idHex)
	if err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "invalid collection id"})
	}

	ctx, cancel := context.WithTimeout(c.Request().Context(), 15*time.Second)
	defer cancel()

	cur, err := h.repo.GetByID(ctx, id)
	if err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			return c.JSON(http.StatusNotFound, map[string]string{"error": "collection not found"})
		}
		return c.JSON(http.StatusInternalServerError, map[string]string{"error": "failed to load collection"})
	}

	if _, err := h.placesRepo.ClearCollectionProperty(ctx, cur.Name); err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]string{"error": "failed to clear collection from places"})
	}

	deleted, err := h.repo.DeleteByID(ctx, id)
	if err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]string{"error": "failed to delete collection"})
	}
	if !deleted {
		return c.JSON(http.StatusNotFound, map[string]string{"error": "collection not found"})
	}
	return c.JSON(http.StatusOK, map[string]string{"message": "collection deleted"})
}
