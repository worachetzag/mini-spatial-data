package collections

import "go.mongodb.org/mongo-driver/bson/primitive"

type Collection struct {
	ID    primitive.ObjectID `bson:"_id,omitempty" json:"id"`
	Name  string             `bson:"name" json:"name"`
	Color string             `bson:"color" json:"color"`
}
