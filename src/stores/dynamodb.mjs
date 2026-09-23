// State store backed by DynamoDB. Used by the Lambda path.
//
// The whole monitor state is one item, keyed by `pk`. That is deliberate: the
// state is a handful of dates read and written as a unit, so a single item keeps
// reads and writes atomic and costs one RCU/WCU. Spreading it across items would
// buy nothing and make partial writes possible.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { EMPTY_STATE } from '../config.mjs';

const TABLE = process.env.STATE_TABLE;
const KEY = process.env.STATE_KEY ?? 'monitor';

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

export const dynamoStore = {
  async read() {
    if (!TABLE) throw new Error('STATE_TABLE env var not set');
    const res = await doc.send(new GetCommand({ TableName: TABLE, Key: { pk: KEY } }));
    if (!res.Item) return { ...EMPTY_STATE };
    const { pk, ...state } = res.Item;
    return { ...EMPTY_STATE, ...state };
  },
  async write(state) {
    if (!TABLE) throw new Error('STATE_TABLE env var not set');
    await doc.send(new PutCommand({ TableName: TABLE, Item: { pk: KEY, ...state } }));
  },
};
