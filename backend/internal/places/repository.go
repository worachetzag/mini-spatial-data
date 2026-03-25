package places

import (
	"context"
	"fmt"

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
		collection: db.Collection("places"),
	}
}

func (r *Repository) List(ctx context.Context, page int64, limit int64) ([]Place, int64, error) {
	total, err := r.collection.CountDocuments(ctx, bson.D{})
	if err != nil {
		return nil, 0, err
	}

	skip := (page - 1) * limit
	findOptions := options.Find().
		SetLimit(limit).
		SetSkip(skip).
		SetSort(bson.D{{Key: "_id", Value: -1}})

	cur, err := r.collection.Find(ctx, bson.D{}, findOptions)
	if err != nil {
		return nil, 0, err
	}
	defer cur.Close(ctx)

	places := make([]Place, 0)
	if err := cur.All(ctx, &places); err != nil {
		return nil, 0, err
	}

	return places, total, nil
}

func (r *Repository) Create(ctx context.Context, place *Place) (primitive.ObjectID, error) {
	res, err := r.collection.InsertOne(ctx, place)
	if err != nil {
		return primitive.NilObjectID, err
	}

	id, ok := res.InsertedID.(primitive.ObjectID)
	if !ok {
		return primitive.NilObjectID, fmt.Errorf("unexpected inserted id type %T", res.InsertedID)
	}

	return id, nil
}

func (r *Repository) GetByID(ctx context.Context, id primitive.ObjectID) (*Place, error) {
	var place Place
	err := r.collection.FindOne(ctx, bson.M{"_id": id}).Decode(&place)
	if err != nil {
		return nil, err
	}
	return &place, nil
}

func (r *Repository) DeleteByID(ctx context.Context, id primitive.ObjectID) (bool, error) {
	res, err := r.collection.DeleteOne(ctx, bson.M{"_id": id})
	if err != nil {
		return false, err
	}

	return res.DeletedCount > 0, nil
}

func (r *Repository) UpdateByID(ctx context.Context, id primitive.ObjectID, setFields bson.M) (bool, error) {
	res, err := r.collection.UpdateByID(ctx, id, bson.M{"$set": setFields})
	if err != nil {
		return false, err
	}
	return res.MatchedCount > 0, nil
}
