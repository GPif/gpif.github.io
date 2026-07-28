---
title: Understanding ActiveRecord Adapters and Building Your Own - Part 2
mermaid: true
date: 2026-07-10 10:00:00 +0200
categories: [dev, ruby]
tags: [ruby, activerecord, database]     # TAG names should always be lowercase
compress_html: false
---

In the [previous article]({% link _posts/2026-07-10-arfirst.md %}), we explored how Active Record adapters are structured and introduced the main classes and modules involved in a connector.

In this article, we'll take the next step by building a minimal Active Record adapter from scratch.

Writing a production-ready adapter is a significant undertaking. Every database has its own SQL dialect, capabilities, and edge cases, and Active Record itself exposes a surprisingly rich API. Fortunately, we don't need to implement everything to understand how adapters work.

To keep the implementation focused on Active Record rather than database internals, we'll use an in-memory SQLite database as our backend. SQLite already handles SQL parsing, storage, and query execution, allowing us to concentrate entirely on the adapter layer.

Rather than implementing dozens of methods up front, we'll follow a __Test-Driven Development (TDD)__ approach.

For each feature, we'll:

1. Write a failing test.
2. Observe the error produced by Active Record.
3. Understand what Active Record expects from the adapter.
4. Implement the smallest amount of code required to make the test pass.

By the end of this article, we'll have a working adapter capable of:

* establishing a connection,
* creating tables using the Active Record schema DSL,
* defining models,
* performing basic CRUD operations.

Along the way, we'll also discover which parts of the Active Record adapter API are truly essential.

---

# Project Setup

Let's begin by generating the skeleton of our gem.

```bash
bundle gem arsimple
```

Our adapter only depends on two libraries:

* `activerecord`, which provides the adapter infrastructure;
* `sqlite3`, which will act as the underlying database engine.

Add both dependencies to your gemspec:

```gemspec
# arsimple.gemspec

spec.add_dependency "activerecord"
spec.add_dependency "sqlite3"
```

## Creating the adapter

Every Active Record adapter inherits from `AbstractAdapter`.

This base class implements all the database-independent behavior and defines the API expected by Active Record. Our adapter will simply provide the database-specific pieces by overriding the appropriate methods.

Create the following file:

```text
lib/
└── active_record/
    └── connection_adapters/
        └── my_adapter.rb
```

with the following implementation:

```ruby
require "active_record"
require "active_record/connection_adapters/abstract_adapter"

module ActiveRecord
  module ConnectionAdapters
    class MyAdapter < AbstractAdapter
    end
  end
end
```

Finally, don't forget to load the adapter from your gem's entry point:

```ruby
# lib/arsimple.rb

require "active_record/connection_adapters/my_adapter"
```

At this point, our adapter doesn't do anything yet—but that's perfectly fine.

The goal isn't to implement everything at once. Instead, we'll let our tests reveal which methods Active Record actually needs, implementing them one by one as we encounter each failure.

---

# Test-Driven Development

An Active Record adapter exposes a surprisingly large API. Depending on the database you're targeting, you may eventually need to implement support for transactions, prepared statements, migrations, asynchronous queries, sharding, savepoints, and much more.

Fortunately, very little of this is required to get started.

Rather than trying to implement every method up front, we'll let Active Record guide us. Each time we write a test, Active Record will eventually reach a method that our adapter doesn't implement yet. The resulting exception tells us exactly which piece of the adapter is missing.

This has two major advantages:

* we only implement the methods that are actually required;
* we gain a much better understanding of how Active Record interacts with an adapter internally.

Let's start with the most fundamental feature: establishing a connection.

---

# Establishing a Connection

The first responsibility of an adapter is, unsurprisingly, to connect to a database.

We'll start with the smallest possible test:

```ruby
it "connects to the database" do
  ActiveRecord::Base.establish_connection(
    adapter: "my_adapter",
    database: ":memory:"
  )

  expect(ActiveRecord::Base.connection)
    .to be_a(ActiveRecord::ConnectionAdapters::MyAdapter)
end
```

Running the test immediately produces the following error:

```
ActiveRecord::AdapterNotFound:
Database configuration specifies nonexistent 'my_adapter' adapter.
Available adapters are: mysql2, postgresql, sqlite3, trilogy.
```

The message is actually quite informative.

Active Record doesn't scan every installed gem looking for adapters. Instead, it maintains an internal registry mapping adapter names (such as `"postgresql"` or `"sqlite3"`) to the Ruby class implementing the adapter.

When `establish_connection` is called, Active Record simply looks up the requested adapter name in this registry. Since `"my_adapter"` isn't registered yet, it has no idea which class should be instantiated.

## Registering the adapter

To make our adapter discoverable, we need to register it when our gem is loaded.

At the bottom of `my_adapter.rb`, add the following call:

```ruby
register(
  "my_adapter",
  "ActiveRecord::ConnectionAdapters::MyAdapter",
  "active_record/connection_adapters/my_adapter"
)
```

The three arguments are:

* the adapter name used in `establish_connection`;
* the fully qualified name of the adapter class;
* the file that should be required if it hasn't already been loaded.

With this registration in place, Active Record can finally locate our adapter class.

Running the test again gets us one step further... and immediately reveals the next missing piece.

This is exactly the workflow we'll follow throughout the rest of this article: write a test, understand why it fails, implement the missing behavior, and repeat until we have a functional adapter.

---

# Creating Our First Table

Connecting to the database is a good start, but it's not very useful on its own. Let's see if our adapter is capable of creating a table using Active Record's schema DSL.

We'll begin with another simple test:

```ruby
it "creates a table" do
  expect do
    ActiveRecord::Schema.define(version: 1) do
      create_table :shows, force: true do |t|
        t.string :name
      end
    end
  end.not_to raise_error
end
```

Running the test immediately produces a new exception:

```text
NotImplementedError:
ActiveRecord::ConnectionAdapters::Quoting::ClassMethods#quote_column_name
```

Once again, the exception tells us exactly what's missing.

## Why does Active Record need `quote_column_name`?

Before Active Record can execute any SQL, it must generate it.

Suppose we create the following table:

```ruby
create_table :shows do |t|
  t.string :name
end
```

Internally, Active Record will eventually build a statement similar to:

```sql
CREATE TABLE "shows" (
  "name" varchar
)
```

Notice that both the table name and the column name are quoted.

This isn't just cosmetic. Quoting identifiers allows SQL keywords, spaces, or special characters to be handled correctly while protecting generated SQL from syntax errors.

The exact quoting syntax depends on the database:

| Database   | Identifier     |
| ---------- | -------------- |
| PostgreSQL | `"column"`     |
| SQLite     | `"column"`     |
| MySQL      | `` `column` `` |
| SQL Server | `[column]`     |

Because we're building a SQLite-based adapter, we simply need to quote identifiers using standard double quotes.

## Implementing the quoting module

Although we could implement `quote_column_name` directly inside our adapter, Active Record separates responsibilities into modules. Following the same organization makes our adapter easier to understand and keeps it consistent with the built-in adapters.

Create a new file:

```text
lib/
└── active_record/
    └── connection_adapters/
        └── my/
            └── quoting.rb
```

Then implement the quoting logic:

```ruby
module ActiveRecord
  module ConnectionAdapters
    module My
      module Quoting
        extend ActiveSupport::Concern

        module ClassMethods
          def quote_column_name(column_name)
            %("#{column_name.to_s.gsub('"', '""')}")
          end
        end
      end
    end
  end
end
```

Finally, require and include the module in your adapter:

```ruby
require "active_record/connection_adapters/my/quoting"

class MyAdapter < AbstractAdapter
  include My::Quoting
end
```

Running the test again gets us a little further before another exception is raised.

This is exactly what we want.

Each failure uncovers another responsibility of an Active Record adapter. Instead of trying to understand the entire adapter API at once, we're discovering it organically, one missing method at a time.

---

# Executing SQL

After implementing identifier quoting, our test progresses a little further before failing again.

This time, Active Record is no longer trying to generate SQL—it is trying to execute it.

An adapter has two distinct responsibilities:

* generating SQL that matches the target database;
* executing that SQL and translating the results back into objects that Active Record understands.

The second responsibility is handled by the `DatabaseStatements` module.

Let's create it first:

```text
lib/
└── active_record/
    └── connection_adapters/
        └── my/
            └── database_statements.rb
```

and require it from our adapter:

```ruby
require "active_record/connection_adapters/my/database_statements"

class MyAdapter < AbstractAdapter
  include My::DatabaseStatements
end
```

As we continue running our test suite, Active Record gradually asks our adapter to implement several methods.

Rather than looking at them as a long checklist, it's easier to understand the role each one plays.

---

## Is this query modifying the database?

The first method Active Record needs is `write_query?`.

```ruby
def write_query?(sql)
  read_query = ActiveRecord::ConnectionAdapters::AbstractAdapter
    .build_read_query_regexp(:pragma)

  !read_query.match?(sql)
end
```

Active Record uses this method to distinguish between queries that only read data (`SELECT`, `PRAGMA`, ...) and queries that modify the database (`INSERT`, `UPDATE`, `DELETE`, `CREATE TABLE`, ...).

This information is used internally for features such as transaction handling, query caching, and connection management.

Fortunately, Active Record already provides a helper to recognize read queries. We simply extend it to treat SQLite's `PRAGMA` statements as read-only operations.

---

## Executing a statement

The most important method in the entire adapter is `perform_query`.

Every SQL statement eventually reaches this method.

Its responsibilities are surprisingly simple:

1. prepare the SQL statement;
2. bind any parameters;
3. execute it;
4. collect the results;
5. return an `ActiveRecord::Result`.

A simplified view of the execution flow looks like this:

```text
Show.create(...)
        │
        ▼
 Active Record
        │
        ▼
perform_query(...)
        │
        ▼
SQLite3::Database
        │
        ▼
ActiveRecord::Result
```

Our implementation closely follows this sequence:

```ruby
def perform_query(raw_connection, sql, binds, type_casted_binds,
                  prepare:, notification_payload:, batch:)

  total_changes_before_query = raw_connection.total_changes

  stmt = raw_connection.prepare(sql)

  begin
    stmt.bind_params(type_casted_binds) unless binds.empty?

    result =
      if stmt.column_count.zero?
        stmt.step

        affected_rows =
          raw_connection.total_changes > total_changes_before_query ?
            raw_connection.changes : 0

        ActiveRecord::Result.empty(
          affected_rows: affected_rows
        )
      else
        rows = stmt.to_a

        affected_rows =
          raw_connection.total_changes > total_changes_before_query ?
            raw_connection.changes : 0

        ActiveRecord::Result.new(
          stmt.columns,
          rows,
          stmt.types.map { |t| type_map.lookup(t) },
          affected_rows: affected_rows
        )
      end
  ensure
    stmt.close
  end

  result
end
```

Although the method appears long, it only performs three operations:

* execute the SQL;
* collect the returned rows (if any);
* wrap everything inside an `ActiveRecord::Result`.

This final step is important because the rest of Active Record expects query results to use this common representation, regardless of the underlying database.

---

## Returning query results

Some database drivers return their own proprietary result objects.

In that case, the adapter must convert them into an `ActiveRecord::Result` by implementing `cast_result`.

SQLite is a little different.

Our implementation of `perform_query` already builds the expected object, so there is nothing left to convert:

```ruby
def cast_result(result)
  result
end
```

---

At this point, our adapter has learned how to execute SQL.

However, Active Record still doesn't know anything about the database itself. Before it can create tables or map models to them, it needs to discover which tables already exist and inspect their structure.

That's the responsibility of the `SchemaStatements` module, which we'll implement next.
If we run our test now, Active Record will throw a cascade of schema-related errors. To solve them all at once, we need to implement the SchemaStatements module and update our main adapter file to handle initialization and basic type mapping.
---

## Schema Statements

Our adapter can now execute SQL, but Active Record needs more than that.

Before it can work with tables and models, it needs to be able to ask the database questions about its own structure:

- Which tables and views exist?
- What columns does a table contain?
- What are their types?
- Which column is the primary key?

This is called **schema introspection**, and Active Record exposes this functionality through the `SchemaStatements` module.

For our first implementation, we'll start with `data_source_sql`, which Active Record uses to discover tables and views.

## Create the schema statements file:

```
lib/
└── active_record/
    └── connection_adapters/
        └── my/
            └── schema_statements.rb
```

```ruby
# frozen_string_literal: true

module ActiveRecord
  module ConnectionAdapters
    module My
      module SchemaStatements
        def data_source_sql(name = nil, type: nil)
          scope = quoted_scope(name, type: type)
          scope[:type] ||= "'table','view'"

          sql = +"SELECT name FROM pragma_table_list WHERE schema <> 'temp'"
          sql << " AND name NOT IN ('sqlite_sequence', 'sqlite_schema')"
          sql << " AND name = #{scope[:name]}" if scope[:name]
          sql << " AND type IN (#{scope[:type]})"
          sql
        end

        def quoted_scope(name = nil, type: nil)
          type = \
            case type
            when "BASE TABLE"
              "'table'"
            when "VIEW"
              "'view'"
            when "VIRTUAL TABLE"
              "'virtual'"
            end
          scope = {}
          scope[:name] = quote(name) if name
          scope[:type] = type if type
          scope
        end
      end
    end
  end
end

```

Now, let's bring everything together in our main adapter file. We need to add the `reconnect` method (which actually establishes the SQLite connection) and list our `native_database_types` so Active Record knows how to map Ruby types to SQL types.

```ruby
# frozen_string_literal: true

require "active_record"
require "active_record/connection_adapters/abstract_adapter"

require "active_record/connection_adapters/my/quoting"
require "active_record/connection_adapters/my/database_statements"
require "active_record/connection_adapters/my/schema_statements"

require "sqlite3"

module ActiveRecord
  module ConnectionAdapters
    class MyAdapter < AbstractAdapter
      include My::Quoting
      include My::DatabaseStatements
      include My::SchemaStatements

      class << self
        def new_client
          ::SQLite3::Database.new(":memory:")
        rescue Errno::ENOENT => e
          raise ActiveRecord::NoDatabaseError if e.message.include?("No such file or directory")

          raise
        end

        def native_database_types
          {
            primary_key: "integer PRIMARY KEY AUTOINCREMENT NOT NULL",
            string: { name: "varchar" },
            text: { name: "text" },
            integer: { name: "integer" },
            float: { name: "float" },
            decimal: { name: "decimal" },
            datetime: { name: "datetime" },
            time: { name: "time" },
            date: { name: "date" },
            binary: { name: "blob" },
            boolean: { name: "boolean" },
            json: { name: "json" }
          }
        end
      end

      def reconnect
        @raw_connection = self.class.new_client
      end
    end
    register("my_adapter", "ActiveRecord::ConnectionAdapters::MyAdapter",
             "active_record/connection_adapters/my_adapter")
  end
end

```

That is indeed a lot of things to implement, but those are the basic building blocks you need to have a working schema. Now that we have them, let's see how we can use our adapter to do basic Create, Read, Update, and Delete operations.

## CRUD Operations

### Create and Read 

Let's write a test to verify we can create a record and read it back:

```ruby
  context "with connection and schema" do
    before(:context) do
      ActiveRecord::Base.establish_connection(
        adapter: "my_adapter",
        database: ":memory:"
      )

      ActiveRecord::Schema.define(version: 1) do
        create_table :shows, force: true do |t|
          t.string :name
          t.integer :episodes
        end
      end
    end

    before(:example) do
      test_record = Class.new(ActiveRecord::Base)

      stub_const("Show", test_record)
    end

    it "create record" do
      s = Show.create(name: "Breaking Bad", episodes: 42)
      expect(s.id).not_to be_nil
      expect(Show.count).to eq(1)
      expect(Show.first.name).to eq("Breaking Bad")
    end
  end
```

Give us the new error:

```
NoMethodError:
       undefined method 'column_definitions' for an instance of ActiveRecord::ConnectionAdapters::MyAdapter
```

To resolve this, we need to add `column_definitions` to our main adapter. This method queries SQLite to figure out what columns exist on a given table.

```ruby
  # Add to MyAdapter  

  def column_definitions(table_name)
    structure = internal_exec_query("PRAGMA table_info(#{quote_table_name(table_name)})", "SCHEMA",
                                    allow_retry: true)
    if structure.empty?
      raise ActiveRecord::StatementInvalid.new("Could not find table '#{table_name}'",
                                               connection_pool: @pool)
    end

    structure.to_a
  end
```

```ruby
# schema_statement

private

def new_column_from_field(_table_name, field, _definitions)
  default_function = nil

  Column.new(
    field["name"],
    lookup_cast_type(field["type"]),
    field["dflt_value"],
    fetch_type_metadata(field["type"]),
    field["notnull"].to_i.zero?,
    default_function,
    collation: field["collation"]
  )
end
```

We also need to tell Active Record how to find the primary key of our table by adding `primary_keys` to our `DatabaseStatements`module:

```ruby
# database_statements 
        
def primary_keys(table)
  r = internal_exec_query("PRAGMA table_info([#{table}]);")
  pk = r.to_a.find { |r| r["pk"] == 1 }
  return pk["name"] if pk

  nil
end
```

Also now some of our query need to bind paramaters. Here doing `Show.first` is translated `SELECT * FROM SHOWS LIMIT ?` with a binding with 1. So we have to alter the perform_query to do it. 

```ruby
# database_statements 
        

def perform_query(raw_connection, intent, binds, type_casted_binds, prepare:, notification_payload:, batch:)
# ...

# Handle bindings for prepared statements
unless binds.nil? || binds.empty?
  stmt.bind_params(type_casted_binds)
end

# ...
end
```

## Returning the generated ID

There is one more problem with `CREATE`.

When we run:

```ruby
show = Show.create(name: "Breaking Bad", episodes: 42)
```

SQLite generates the primary key, but Active Record also needs to know that value
so it can assign it to show.id.

One way to achieve this is with SQL's RETURNING clause:

```SQL
INSERT INTO shows (name, episodes)
VALUES ('Breaking Bad', 42)
RETURNING id
```

Active Record uses the adapter's supports_insert_returning? capability to
determine whether the database can perform this operation.

Since our SQLite backend supports it, we can enable the capability:

```ruby
# To return ID
def supports_insert_returning?
  true
end
```

Now Active Record can retrieve the generated primary key and assign it to the
Ruby object.

### Update and Delete

Test :

```ruby
  it "update record" do
    s = Show.create(name: "Breaking Bad", episodes: 42)
    s.episodes = 47
    s.save!

    expect(s.reload.episodes).to eq(47)
  end
```

Error :

```
Failure/Error: s.save!

NotImplementedError:
  NotImplementedError
```

The missing part is to return the affected row 

```ruby
def affected_rows(result)
  result.affected_rows
end
```

Interestingly, `destroy` requires no additional adapter-specific implementation.

```ruby
it "delete record" do
  s = Show.create(name: "Breaking Bad", episodes: 42)
  expect(Show.count).to eq(1)
  s.destroy
  expect(Show.count).to eq(0)
end
```

The SQL generated by Active Record is already supported by the functionality
we've implemented, so the test passes without changing the adapter.

This is one of the strengths of Active Record's adapter architecture: once an
adapter provides the primitives expected by the framework, higher-level
operations can work without requiring database-specific implementations.

## What we've implemented

At this point, our minimal adapter can:

- connect to the database;
- generate quoted SQL identifiers;
- execute SQL and bind parameters;
- inspect the database schema;
- map database types;
- retrieve primary keys;
- return generated IDs;
- report affected rows;
- perform basic CRUD operations.

That's already enough to make a surprisingly large part of Active Record work.

The whole code can be found [on my github](https://github.com/GPif/arsimple){:target="_blank"}