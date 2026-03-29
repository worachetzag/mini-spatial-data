package places

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/labstack/echo/v4"
	"github.com/xuri/excelize/v2"
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

type BulkDeleteInput struct {
	IDs []string `json:"ids"`
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

	nameQuery := strings.TrimSpace(c.QueryParam("q"))
	collectionQuery := strings.TrimSpace(c.QueryParam("collection"))

	ctx, cancel := context.WithTimeout(c.Request().Context(), 5*time.Second)
	defer cancel()

	places, total, err := h.repo.List(ctx, page, limit, nameQuery, collectionQuery)
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

// MapList returns all places matching the list filters (same q/collection as GET /api/places), without pagination, for map rendering.
func (h *Handler) MapList(c echo.Context) error {
	nameQuery := strings.TrimSpace(c.QueryParam("q"))
	collectionQuery := strings.TrimSpace(c.QueryParam("collection"))

	ctx, cancel := context.WithTimeout(c.Request().Context(), 60*time.Second)
	defer cancel()

	places, err := h.repo.ListAllFiltered(ctx, nameQuery, collectionQuery)
	if err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]string{
			"error": "failed to load places for map",
		})
	}

	return c.JSON(http.StatusOK, map[string]any{
		"count": len(places),
		"data":  places,
	})
}

func (h *Handler) Collections(c echo.Context) error {
	ctx, cancel := context.WithTimeout(c.Request().Context(), 5*time.Second)
	defer cancel()

	list, err := h.repo.DistinctCollections(ctx)
	if err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]string{
			"error": "failed to list collections",
		})
	}

	return c.JSON(http.StatusOK, map[string]any{
		"data": list,
	})
}

func (h *Handler) Export(c echo.Context) error {
	format := strings.ToLower(strings.TrimSpace(c.QueryParam("format")))
	if format == "" {
		format = "csv"
	}
	if format != "csv" && format != "xlsx" {
		return c.JSON(http.StatusBadRequest, map[string]string{
			"error": "format must be csv or xlsx",
		})
	}

	ctx, cancel := context.WithTimeout(c.Request().Context(), 15*time.Second)
	defer cancel()

	ids, err := parseIDFilters(c)
	if err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{
			"error": err.Error(),
		})
	}

	var places []Place
	if len(ids) > 0 {
		places, err = h.repo.ListByIDs(ctx, ids)
	} else {
		places, err = h.repo.ListAll(ctx)
	}
	if err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]string{
			"error": "failed to export places",
		})
	}

	if format == "xlsx" {
		content, err := buildXLSX(places)
		if err != nil {
			return c.JSON(http.StatusInternalServerError, map[string]string{
				"error": "failed to build xlsx",
			})
		}
		c.Response().Header().Set(echo.HeaderContentDisposition, `attachment; filename="places.xlsx"`)
		return c.Blob(http.StatusOK, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", content)
	}

	content, err := buildCSV(places)
	if err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]string{
			"error": "failed to build csv",
		})
	}
	c.Response().Header().Set(echo.HeaderContentDisposition, `attachment; filename="places.csv"`)
	return c.Blob(http.StatusOK, "text/csv; charset=utf-8", content)
}

func (h *Handler) DeleteMany(c echo.Context) error {
	var input BulkDeleteInput
	if err := c.Bind(&input); err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{
			"error": "invalid request body",
		})
	}
	if len(input.IDs) == 0 {
		return c.JSON(http.StatusBadRequest, map[string]string{
			"error": "ids is required",
		})
	}

	ids := make([]primitive.ObjectID, 0, len(input.IDs))
	seen := map[primitive.ObjectID]struct{}{}
	for _, raw := range input.IDs {
		id, err := primitive.ObjectIDFromHex(strings.TrimSpace(raw))
		if err != nil {
			return c.JSON(http.StatusBadRequest, map[string]string{
				"error": "invalid id in ids list",
			})
		}
		if _, exists := seen[id]; exists {
			continue
		}
		seen[id] = struct{}{}
		ids = append(ids, id)
	}
	if len(ids) == 0 {
		return c.JSON(http.StatusBadRequest, map[string]string{
			"error": "ids is required",
		})
	}

	ctx, cancel := context.WithTimeout(c.Request().Context(), 10*time.Second)
	defer cancel()

	deletedCount, err := h.repo.DeleteManyByIDs(ctx, ids)
	if err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]string{
			"error": "failed to delete selected places",
		})
	}

	return c.JSON(http.StatusOK, map[string]any{
		"message": "selected places deleted",
		"deleted": deletedCount,
	})
}

func (h *Handler) Import(c echo.Context) error {
	format := strings.ToLower(strings.TrimSpace(c.QueryParam("format")))
	if format == "" {
		format = "csv"
	}
	if format != "csv" && format != "xlsx" {
		return c.JSON(http.StatusBadRequest, map[string]string{
			"error": "format must be csv or xlsx",
		})
	}

	fileHeader, err := c.FormFile("file")
	if err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{
			"error": "file is required (multipart field name: file)",
		})
	}

	file, err := fileHeader.Open()
	if err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{
			"error": "failed to open uploaded file",
		})
	}
	defer file.Close()

	places, err := parseImportFile(file, fileHeader, format)
	if err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{
			"error": err.Error(),
		})
	}
	if len(places) == 0 {
		return c.JSON(http.StatusBadRequest, map[string]string{
			"error": "no valid rows found to import",
		})
	}

	ctx, cancel := context.WithTimeout(c.Request().Context(), 20*time.Second)
	defer cancel()

	inserted, err := h.repo.CreateMany(ctx, places)
	if err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]string{
			"error": "failed to import places",
		})
	}

	if err := h.repo.EnsureRegistryCollectionsFromPlaces(ctx, places); err != nil {
		c.Logger().Warnf("import: ensure registry collections: %v", err)
	}

	return c.JSON(http.StatusOK, map[string]any{
		"message":  "import completed",
		"inserted": inserted,
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
	if input.Type == "" {
		input.Type = "Feature"
	}

	if input.Type != "Feature" {
		return c.JSON(http.StatusBadRequest, map[string]string{
			"error": "type must be Feature",
		})
	}

	if err := validateAndNormalizeGeometry(&input.Geometry); err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{
			"error": err.Error(),
		})
	}

	if input.Properties == nil {
		input.Properties = map[string]any{}
	}
	trimCollectionInProperties(input.Properties)

	ctx, cancel := context.WithTimeout(c.Request().Context(), 5*time.Second)
	defer cancel()

	id, err := h.repo.Create(ctx, &input)
	if err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]string{
			"error": "failed to create place",
		})
	}
	input.ID = id

	if err := h.repo.EnsureRegistryCollectionsFromPlaces(ctx, []Place{input}); err != nil {
		c.Logger().Warnf("create: ensure registry collections: %v", err)
	}

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
		if err := validateAndNormalizeGeometry(input.Geometry); err != nil {
			return c.JSON(http.StatusBadRequest, map[string]string{
				"error": err.Error(),
			})
		}
		setFields["geometry"] = input.Geometry
	}

	if input.Properties != nil {
		trimCollectionInProperties(input.Properties)
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

	if err := h.repo.EnsureRegistryCollectionsFromPlaces(ctx, []Place{*place}); err != nil {
		c.Logger().Warnf("update: ensure registry collections: %v", err)
	}

	return c.JSON(http.StatusOK, place)
}

func trimCollectionInProperties(props map[string]any) {
	if props == nil {
		return
	}
	raw, ok := props["collection"]
	if !ok || raw == nil {
		return
	}
	switch v := raw.(type) {
	case string:
		props["collection"] = strings.TrimSpace(v)
	default:
		props["collection"] = strings.TrimSpace(fmt.Sprint(v))
	}
}

func buildCSV(places []Place) ([]byte, error) {
	var builder strings.Builder
	writer := csv.NewWriter(&builder)
	if err := writer.Write([]string{"id", "type", "geometry_type", "collection", "longitude", "latitude", "coordinates_json", "name"}); err != nil {
		return nil, err
	}
	for _, place := range places {
		lng, lat, coordsJSON := ExportCoordinateSummary(place.Geometry)
		name := strings.TrimSpace(fmt.Sprintf("%v", place.Properties["name"]))
		collection := propertyCollection(place.Properties)
		if err := writer.Write([]string{
			place.ID.Hex(),
			place.Type,
			place.Geometry.Type,
			collection,
			lng,
			lat,
			coordsJSON,
			name,
		}); err != nil {
			return nil, err
		}
	}
	writer.Flush()
	if err := writer.Error(); err != nil {
		return nil, err
	}
	return []byte(builder.String()), nil
}

func buildXLSX(places []Place) ([]byte, error) {
	file := excelize.NewFile()
	sheet := file.GetSheetName(0)
	headers := []string{"id", "type", "geometry_type", "collection", "longitude", "latitude", "coordinates_json", "name"}

	for i, header := range headers {
		cell, _ := excelize.CoordinatesToCellName(i+1, 1)
		if err := file.SetCellValue(sheet, cell, header); err != nil {
			return nil, err
		}
	}

	for rowIdx, place := range places {
		row := rowIdx + 2
		lng, lat, coordsJSON := ExportCoordinateSummary(place.Geometry)
		name := strings.TrimSpace(fmt.Sprintf("%v", place.Properties["name"]))
		collection := propertyCollection(place.Properties)
		values := []string{place.ID.Hex(), place.Type, place.Geometry.Type, collection, lng, lat, coordsJSON, name}
		for col, value := range values {
			cell, _ := excelize.CoordinatesToCellName(col+1, row)
			if err := file.SetCellValue(sheet, cell, value); err != nil {
				return nil, err
			}
		}
	}

	buf, err := file.WriteToBuffer()
	if err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func parseImportFile(file multipart.File, fileHeader *multipart.FileHeader, format string) ([]Place, error) {
	if format == "xlsx" || strings.HasSuffix(strings.ToLower(fileHeader.Filename), ".xlsx") {
		return parseXLSX(file)
	}
	return parseCSV(file)
}

func parseCSV(file io.Reader) ([]Place, error) {
	reader := csv.NewReader(file)
	rows, err := reader.ReadAll()
	if err != nil {
		return nil, fmt.Errorf("invalid csv: %w", err)
	}
	if len(rows) <= 1 {
		return nil, nil
	}

	return parseRowsByHeader(rows)
}

func parseXLSX(file io.Reader) ([]Place, error) {
	excelFile, err := excelize.OpenReader(file)
	if err != nil {
		return nil, fmt.Errorf("invalid xlsx: %w", err)
	}
	sheet := excelFile.GetSheetName(0)
	if sheet == "" {
		return nil, fmt.Errorf("xlsx file has no sheet")
	}
	rows, err := excelFile.GetRows(sheet)
	if err != nil {
		return nil, fmt.Errorf("failed to read xlsx rows: %w", err)
	}
	if len(rows) <= 1 {
		return nil, nil
	}

	return parseRowsByHeader(rows)
}

func parseRowsByHeader(rows [][]string) ([]Place, error) {
	headerMap := map[string]int{}
	for idx, raw := range rows[0] {
		headerMap[normalizeHeader(raw)] = idx
	}

	nameIdx, ok := headerMap["name"]
	if !ok {
		return nil, fmt.Errorf("missing required column: name")
	}

	lonIdx, ok := firstExistingIndex(headerMap, []string{"longitude", "lon", "lng"})
	if !ok {
		return nil, fmt.Errorf("missing required column: longitude/lon/lng")
	}

	latIdx, ok := firstExistingIndex(headerMap, []string{"latitude", "lat"})
	if !ok {
		return nil, fmt.Errorf("missing required column: latitude/lat")
	}

	typeIdx, hasType := headerMap["type"]
	geometryTypeIdx, hasGeometryType := firstExistingIndex(headerMap, []string{"geometry_type", "geometrytype"})
	collectionIdx, hasCollection := headerMap["collection"]
	coordsJSONIdx, hasCoordsJSON := firstExistingIndex(headerMap, []string{"coordinates_json", "coordinatesjson"})

	places := make([]Place, 0, len(rows)-1)
	for i, row := range rows[1:] {
		name := cellValue(row, nameIdx)
		lon := cellValue(row, lonIdx)
		lat := cellValue(row, latIdx)

		featureType := ""
		if hasType {
			featureType = cellValue(row, typeIdx)
		}
		geometryType := ""
		if hasGeometryType {
			geometryType = cellValue(row, geometryTypeIdx)
		}
		collection := ""
		if hasCollection {
			collection = cellValue(row, collectionIdx)
		}
		coordsJSON := ""
		if hasCoordsJSON {
			coordsJSON = cellValue(row, coordsJSONIdx)
		}

		place, err := parsePlaceRow(featureType, geometryType, collection, coordsJSON, lon, lat, name, i+2)
		if err != nil {
			return nil, err
		}
		places = append(places, place)
	}
	return places, nil
}

func normalizeHeader(value string) string {
	v := strings.TrimSpace(strings.ToLower(value))
	v = strings.ReplaceAll(v, " ", "_")
	v = strings.ReplaceAll(v, "-", "_")
	return v
}

func firstExistingIndex(headerMap map[string]int, keys []string) (int, bool) {
	for _, key := range keys {
		if idx, ok := headerMap[key]; ok {
			return idx, true
		}
	}
	return 0, false
}

func cellValue(row []string, idx int) string {
	if idx < 0 || idx >= len(row) {
		return ""
	}
	return row[idx]
}

func parsePlaceRow(featureType, geometryType, collection, coordsJSONRaw, lngRaw, latRaw, nameRaw string, rowNumber int) (Place, error) {
	placeType := strings.TrimSpace(featureType)
	if placeType == "" {
		placeType = "Feature"
	}
	if placeType != "Feature" {
		return Place{}, fmt.Errorf("row %d: type must be Feature", rowNumber)
	}

	geoType := strings.TrimSpace(geometryType)
	if geoType == "" {
		geoType = "Point"
	}

	name := strings.TrimSpace(nameRaw)
	if name == "" {
		return Place{}, fmt.Errorf("row %d: name is required", rowNumber)
	}

	collection = strings.TrimSpace(collection)

	var coords any
	switch geoType {
	case "Point":
		lng, err := strconv.ParseFloat(strings.TrimSpace(lngRaw), 64)
		if err != nil {
			return Place{}, fmt.Errorf("row %d: invalid longitude", rowNumber)
		}
		lat, err := strconv.ParseFloat(strings.TrimSpace(latRaw), 64)
		if err != nil {
			return Place{}, fmt.Errorf("row %d: invalid latitude", rowNumber)
		}
		coords = []float64{lng, lat}
	case "LineString", "Polygon":
		raw := strings.TrimSpace(coordsJSONRaw)
		if raw == "" {
			return Place{}, fmt.Errorf("row %d: coordinates_json is required for geometry_type %s", rowNumber, geoType)
		}
		var parsed any
		if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
			return Place{}, fmt.Errorf("row %d: invalid coordinates_json: %w", rowNumber, err)
		}
		coords = parsed
	default:
		return Place{}, fmt.Errorf("row %d: unsupported geometry_type %q (use Point, LineString, or Polygon)", rowNumber, geoType)
	}

	g := Geometry{Type: geoType, Coordinates: coords}
	if err := validateAndNormalizeGeometry(&g); err != nil {
		return Place{}, fmt.Errorf("row %d: %w", rowNumber, err)
	}

	props := map[string]any{"name": name}
	if collection != "" {
		props["collection"] = collection
	}

	return Place{
		Type:       placeType,
		Geometry:   g,
		Properties: props,
	}, nil
}

func parseIDFilters(c echo.Context) ([]primitive.ObjectID, error) {
	rawIDs := make([]string, 0)
	if raw := strings.TrimSpace(c.QueryParam("ids")); raw != "" {
		parts := strings.Split(raw, ",")
		for _, part := range parts {
			if v := strings.TrimSpace(part); v != "" {
				rawIDs = append(rawIDs, v)
			}
		}
	}
	for _, v := range c.QueryParams()["id"] {
		if id := strings.TrimSpace(v); id != "" {
			rawIDs = append(rawIDs, id)
		}
	}

	if len(rawIDs) == 0 {
		return nil, nil
	}

	ids := make([]primitive.ObjectID, 0, len(rawIDs))
	seen := map[primitive.ObjectID]struct{}{}
	for _, raw := range rawIDs {
		id, err := primitive.ObjectIDFromHex(raw)
		if err != nil {
			return nil, fmt.Errorf("invalid export id")
		}
		if _, exists := seen[id]; exists {
			continue
		}
		seen[id] = struct{}{}
		ids = append(ids, id)
	}
	return ids, nil
}
