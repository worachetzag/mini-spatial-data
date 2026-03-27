package places

import "go.mongodb.org/mongo-driver/bson/primitive"

type Geometry struct {
	Type        string `bson:"type" json:"type"`
	Coordinates any    `bson:"coordinates" json:"coordinates"`
}

type Place struct {
	ID         primitive.ObjectID `bson:"_id,omitempty" json:"id"`
	Type       string             `bson:"type" json:"type"`
	Geometry   Geometry           `bson:"geometry" json:"geometry"`
	Properties map[string]any     `bson:"properties" json:"properties"`
}
