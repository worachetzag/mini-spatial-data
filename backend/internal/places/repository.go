package places

import (
	"context"
	"fmt"
	"regexp"
	"sort"
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
		collection: db.Collection("places"),
	}
}

func (r *Repository) List(ctx context.Context, page int64, limit int64, nameQuery, collectionQuery string) ([]Place, int64, error) {
	filter := bson.M{}
	if q := strings.TrimSpace(nameQuery); q != "" {
		pattern := regexp.QuoteMeta(q)
		filter["$or"] = []bson.M{
			{"properties.name": bson.M{"$regex": pattern, "$options": "i"}},
			{"properties.collection": bson.M{"$regex": pattern, "$options": "i"}},
		}
	}
	if c := strings.TrimSpace(collectionQuery); c != "" {
		pattern := regexp.QuoteMeta(c)
		filter["properties.collection"] = bson.M{"$regex": pattern, "$options": "i"}
	}

	total, err := r.collection.CountDocuments(ctx, filter)
	if err != nil {
		return nil, 0, err
	}

	skip := (page - 1) * limit
	findOptions := options.Find().
		SetLimit(limit).
		SetSkip(skip).
		SetSort(bson.D{{Key: "_id", Value: -1}})

	cur, err := r.collection.Find(ctx, filter, findOptions)
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

func (r *Repository) ListAll(ctx context.Context) ([]Place, error) {
	findOptions := options.Find().
		SetSort(bson.D{{Key: "_id", Value: -1}})

	cur, err := r.collection.Find(ctx, bson.D{}, findOptions)
	if err != nil {
		return nil, err
	}
	defer cur.Close(ctx)

	places := make([]Place, 0)
	if err := cur.All(ctx, &places); err != nil {
		return nil, err
	}

	return places, nil
}

func (r *Repository) ListByIDs(ctx context.Context, ids []primitive.ObjectID) ([]Place, error) {
	findOptions := options.Find().
		SetSort(bson.D{{Key: "_id", Value: -1}})

	cur, err := r.collection.Find(ctx, bson.M{"_id": bson.M{"$in": ids}}, findOptions)
	if err != nil {
		return nil, err
	}
	defer cur.Close(ctx)

	places := make([]Place, 0)
	if err := cur.All(ctx, &places); err != nil {
		return nil, err
	}

	return places, nil
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

func (r *Repository) CreateMany(ctx context.Context, places []Place) (int64, error) {
	if len(places) == 0 {
		return 0, nil
	}

	docs := make([]any, 0, len(places))
	for i := range places {
		places[i].ID = primitive.NilObjectID
		docs = append(docs, places[i])
	}

	res, err := r.collection.InsertMany(ctx, docs)
	if err != nil {
		return 0, err
	}

	return int64(len(res.InsertedIDs)), nil
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

func (r *Repository) DeleteManyByIDs(ctx context.Context, ids []primitive.ObjectID) (int64, error) {
	res, err := r.collection.DeleteMany(ctx, bson.M{"_id": bson.M{"$in": ids}})
	if err != nil {
		return 0, err
	}
	return res.DeletedCount, nil
}

func (r *Repository) UpdateByID(ctx context.Context, id primitive.ObjectID, setFields bson.M) (bool, error) {
	res, err := r.collection.UpdateByID(ctx, id, bson.M{"$set": setFields})
	if err != nil {
		return false, err
	}
	return res.MatchedCount > 0, nil
}

func (r *Repository) RenameCollectionProperty(ctx context.Context, oldName, newName string) (int64, error) {
	filter := bson.M{"properties.collection": oldName}
	update := bson.M{"$set": bson.M{"properties.collection": newName}}
	res, err := r.collection.UpdateMany(ctx, filter, update)
	if err != nil {
		return 0, err
	}
	return res.ModifiedCount, nil
}

func (r *Repository) ClearCollectionProperty(ctx context.Context, name string) (int64, error) {
	filter := bson.M{"properties.collection": name}
	update := bson.M{"$unset": bson.M{"properties.collection": ""}}
	res, err := r.collection.UpdateMany(ctx, filter, update)
	if err != nil {
		return 0, err
	}
	return res.ModifiedCount, nil
}

func (r *Repository) DistinctCollections(ctx context.Context) ([]string, error) {
	vals, err := r.collection.Distinct(ctx, "properties.collection", bson.M{})
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, len(vals))
	seen := map[string]struct{}{}
	for _, v := range vals {
		s, ok := v.(string)
		if !ok {
			continue
		}
		s = strings.TrimSpace(s)
		if s == "" {
			continue
		}
		if _, dup := seen[s]; dup {
			continue
		}
		seen[s] = struct{}{}
		out = append(out, s)
	}
	sort.Strings(out)
	return out, nil
}
