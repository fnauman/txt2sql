/* jshint indent: 1 */

module.exports = function(sequelize, DataTypes) {
	// ProductCategory: synthetic product category master with optional hierarchy.
	const ProductCategory = sequelize.define('ProductCategory', {
		ProductCategoryId: {
			type: DataTypes.INTEGER(10),
			allowNull: false,
			primaryKey: true,
			autoIncrement: true,
			comment: 'Primary key for the product category.'
		},
		CategoryCode: {
			type: DataTypes.STRING(20),
			allowNull: true,
			unique: true,
			comment: 'Synthetic category code.'
		},
		CategoryName: {
			type: DataTypes.STRING(120),
			allowNull: true,
			comment: 'Synthetic category display name.'
		},
		ParentCategoryId: {
			type: DataTypes.INTEGER(10),
			allowNull: true,
			references: { model: 'ProductCategory', key: 'ProductCategoryId' },
			comment: 'Optional parent category for hierarchy.'
		}
	}, {
		tableName: 'ProductCategory',
		timestamps: false,
		freezeTableName: true
	});

	ProductCategory.associate = (models) => {
		ProductCategory.belongsTo(models.ProductCategory, { foreignKey: 'ParentCategoryId', as: 'ParentCategory' });
		ProductCategory.hasMany(models.Product, { foreignKey: 'ProductCategoryId', as: 'Products' });
		ProductCategory.hasMany(models.Brand, { foreignKey: 'ProductCategoryId', as: 'Brands' });
	};

	return ProductCategory;
};
