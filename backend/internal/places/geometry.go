package places

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"

	"go.mongodb.org/mongo-driver/bson/primitive"
)

const epsilon = 1e-9

func validateAndNormalizeGeometry(g *Geometry) error {
	if g == nil {
		return errors.New("geometry is required")
	}
	g.Type = strings.TrimSpace(g.Type)
	switch g.Type {
	case "Point":
		lng, lat, err := parsePointPair(g.Coordinates)
		if err != nil {
			return fmt.Errorf("point: %w", err)
		}
		g.Coordinates = []float64{lng, lat}
	case "LineString":
		line, err := parseLineStringPositions(g.Coordinates)
		if err != nil {
			return fmt.Errorf("linestring: %w", err)
		}
		if len(line) < 2 {
			return errors.New("linestring must have at least 2 positions")
		}
		g.Coordinates = lineToAnySlice(line)
	case "Polygon":
		rings, err := parsePolygonRings(g.Coordinates)
		if err != nil {
			return fmt.Errorf("polygon: %w", err)
		}
		if len(rings) == 0 {
			return errors.New("polygon must have at least one ring")
		}
		g.Coordinates = ringsToAnySlice(rings)
	default:
		return fmt.Errorf("unsupported geometry type %q (use Point, LineString, or Polygon)", g.Type)
	}
	return nil
}

func parsePointPair(v any) (lng, lat float64, err error) {
	pair, err := asFloatPair(v)
	if err != nil {
		return 0, 0, err
	}
	if math.Abs(pair[0]) > 180 || math.Abs(pair[1]) > 90 {
		return 0, 0, errors.New("coordinates out of range (lng [-180,180], lat [-90,90])")
	}
	return pair[0], pair[1], nil
}

func parseLineStringPositions(v any) ([][2]float64, error) {
	arr, ok := asPositionArray(v)
	if !ok {
		return nil, errors.New("invalid linestring coordinates")
	}
	return arr, nil
}

func parsePolygonRings(v any) ([][][2]float64, error) {
	raw, ok := normalizeSlice(v)
	if !ok || len(raw) == 0 {
		return nil, errors.New("coordinates must be an array of linear rings")
	}
	first, ok := asPositionArray(raw[0])
	if !ok || len(first) < 4 {
		return nil, errors.New("each ring must have at least 4 positions (closed ring)")
	}
	rings := make([][][2]float64, 0, len(raw))
	for i, ringAny := range raw {
		ring, ok := asPositionArray(ringAny)
		if !ok {
			return nil, fmt.Errorf("ring %d: invalid position list", i)
		}
		if len(ring) < 4 {
			return nil, fmt.Errorf("ring %d: need at least 4 positions", i)
		}
		if !positionsEqual(ring[0], ring[len(ring)-1]) {
			return nil, fmt.Errorf("ring %d: first and last position must match (closed ring)", i)
		}
		rings = append(rings, ring)
	}
	return rings, nil
}

func positionsEqual(a, b [2]float64) bool {
	return math.Abs(a[0]-b[0]) < epsilon && math.Abs(a[1]-b[1]) < epsilon
}

func lineToAnySlice(line [][2]float64) any {
	out := make([]any, len(line))
	for i, p := range line {
		out[i] = []any{p[0], p[1]}
	}
	return out
}

func ringsToAnySlice(rings [][][2]float64) any {
	out := make([]any, len(rings))
	for i, ring := range rings {
		pts := make([]any, len(ring))
		for j, p := range ring {
			pts[j] = []any{p[0], p[1]}
		}
		out[i] = pts
	}
	return out
}

func normalizeSlice(v any) ([]any, bool) {
	switch t := v.(type) {
	case primitive.A:
		v = []any(t)
	case []float64, []int, json.Number:
		return nil, false
	}
	arr, ok := v.([]any)
	return arr, ok
}

func asFloatPair(v any) ([2]float64, error) {
	var zero [2]float64
	switch t := v.(type) {
	case primitive.A:
		return asFloatPair([]any(t))
	case []float64:
		if len(t) < 2 {
			return zero, errors.New("need [lng, lat]")
		}
		return [2]float64{t[0], t[1]}, nil
	case []any:
		if len(t) < 2 {
			return zero, errors.New("need [lng, lat]")
		}
		x, ok1 := toFloat64(t[0])
		y, ok2 := toFloat64(t[1])
		if !ok1 || !ok2 {
			return zero, errors.New("lng and lat must be numbers")
		}
		return [2]float64{x, y}, nil
	default:
		b, err := json.Marshal(v)
		if err != nil {
			return zero, errors.New("invalid coordinates")
		}
		var pair []float64
		if err := json.Unmarshal(b, &pair); err != nil || len(pair) < 2 {
			return zero, errors.New("need [lng, lat] array")
		}
		return [2]float64{pair[0], pair[1]}, nil
	}
}

func asPositionArray(v any) ([][2]float64, bool) {
	switch t := v.(type) {
	case primitive.A:
		return asPositionArray([]any(t))
	case []any:
		out := make([][2]float64, 0, len(t))
		for _, item := range t {
			pair, err := asFloatPair(item)
			if err != nil {
				return nil, false
			}
			out = append(out, pair)
		}
		return out, true
	default:
		b, err := json.Marshal(v)
		if err != nil {
			return nil, false
		}
		var raw [][]float64
		if err := json.Unmarshal(b, &raw); err != nil {
			return nil, false
		}
		out := make([][2]float64, len(raw))
		for i, row := range raw {
			if len(row) < 2 {
				return nil, false
			}
			out[i] = [2]float64{row[0], row[1]}
		}
		return out, true
	}
}

func toFloat64(x any) (float64, bool) {
	switch n := x.(type) {
	case float64:
		return n, true
	case float32:
		return float64(n), true
	case int:
		return float64(n), true
	case int32:
		return float64(n), true
	case int64:
		return float64(n), true
	case json.Number:
		f, err := n.Float64()
		return f, err == nil
	default:
		return 0, false
	}
}

func propertyCollection(props map[string]any) string {
	if props == nil {
		return ""
	}
	raw, ok := props["collection"]
	if !ok || raw == nil {
		return ""
	}
	switch v := raw.(type) {
	case string:
		return strings.TrimSpace(v)
	default:
		return strings.TrimSpace(fmt.Sprint(v))
	}
}

func geometryBBox(g Geometry) (minLng, minLat, maxLng, maxLat float64, ok bool) {
	switch g.Type {
	case "Point":
		pair, err := asFloatPair(g.Coordinates)
		if err != nil {
			return 0, 0, 0, 0, false
		}
		return pair[0], pair[1], pair[0], pair[1], true
	case "LineString":
		line, ok := asPositionArray(g.Coordinates)
		if !ok || len(line) == 0 {
			return 0, 0, 0, 0, false
		}
		return bboxFromPositions(line)
	case "Polygon":
		rings, err := parsePolygonRings(g.Coordinates)
		if err != nil || len(rings) == 0 {
			return 0, 0, 0, 0, false
		}
		var all [][2]float64
		for _, ring := range rings {
			all = append(all, ring...)
		}
		return bboxFromPositions(all)
	default:
		return 0, 0, 0, 0, false
	}
}

func bboxFromPositions(pts [][2]float64) (minLng, minLat, maxLng, maxLat float64, ok bool) {
	if len(pts) == 0 {
		return 0, 0, 0, 0, false
	}
	minLng, maxLng = pts[0][0], pts[0][0]
	minLat, maxLat = pts[0][1], pts[0][1]
	for _, p := range pts[1:] {
		if p[0] < minLng {
			minLng = p[0]
		}
		if p[0] > maxLng {
			maxLng = p[0]
		}
		if p[1] < minLat {
			minLat = p[1]
		}
		if p[1] > maxLat {
			maxLat = p[1]
		}
	}
	return minLng, minLat, maxLng, maxLat, true
}

// ExportCoordinateSummary formats table export fields for mixed geometry types.
func ExportCoordinateSummary(g Geometry) (lng, lat, coordsJSON string) {
	switch g.Type {
	case "Point":
		pair, err := asFloatPair(g.Coordinates)
		if err != nil {
			return "", "", ""
		}
		return fmt.Sprintf("%g", pair[0]), fmt.Sprintf("%g", pair[1]), ""
	default:
		b, err := json.Marshal(g.Coordinates)
		if err != nil {
			return "", "", ""
		}
		coordsJSON = string(b)
		minL, minLa, maxL, maxLa, ok := geometryBBox(g)
		if ok {
			cx := (minL + maxL) / 2
			cy := (minLa + maxLa) / 2
			return fmt.Sprintf("%g", cx), fmt.Sprintf("%g", cy), coordsJSON
		}
		return "", "", coordsJSON
	}
}
