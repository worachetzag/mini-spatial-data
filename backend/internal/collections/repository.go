package collections

import (
	"context"
	"errors"
	"strings"

	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/bson/primitive"
	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"
)

type Repository struct {
	collection *mongo.Collection
}

func NewRepository(db *mongo.Database) *Repository {
	return &Repository{
		collection: db.Collection("place_collections"),
	}
}

func (r *Repository) List(ctx context.Context) ([]Collection, error) {
	cur, err := r.collection.Find(ctx, bson.D{}, options.Find().SetSort(bson.D{{Key: "name", Value: 1}}))
	if err != nil {
		return nil, err
	}
	defer cur.Close(ctx)

	out := make([]Collection, 0)
	if err := cur.All(ctx, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func (r *Repository) FindByName(ctx context.Context, name string) (*Collection, error) {
	var c Collection
	err := r.collection.FindOne(ctx, bson.M{"name": name}).Decode(&c)
	if err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			return nil, nil
		}
		return nil, err
	}
	return &c, nil
}

func (r *Repository) Create(ctx context.Context, c *Collection) (primitive.ObjectID, error) {
	c.ID = primitive.NilObjectID
	res, err := r.collection.InsertOne(ctx, c)
	if err != nil {
		return primitive.NilObjectID, err
	}
	id, ok := res.InsertedID.(primitive.ObjectID)
	if !ok {
		return primitive.NilObjectID, errors.New("unexpected insert id type")
	}
	return id, nil
}

func (r *Repository) GetByID(ctx context.Context, id primitive.ObjectID) (*Collection, error) {
	var c Collection
	err := r.collection.FindOne(ctx, bson.M{"_id": id}).Decode(&c)
	if err != nil {
		return nil, err
	}
	return &c, nil
}

func (r *Repository) UpdateByID(ctx context.Context, id primitive.ObjectID, set bson.M) (bool, error) {
	if len(set) == 0 {
		return false, nil
	}
	res, err := r.collection.UpdateByID(ctx, id, bson.M{"$set": set})
	if err != nil {
		return false, err
	}
	return res.MatchedCount > 0, nil
}

func (r *Repository) DeleteByID(ctx context.Context, id primitive.ObjectID) (bool, error) {
	res, err := r.collection.DeleteOne(ctx, bson.M{"_id": id})
	if err != nil {
		return false, err
	}
	return res.DeletedCount > 0, nil
}

func NormalizeName(s string) string {
	return strings.TrimSpace(s)
}
